import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one } from '../../lib/db.js';
import { clientMeta, IdParams, typed } from '../../lib/http.js';
import { splitPayout, type PayoutRule } from '../../lib/money.js';
import { requireProviderId } from '../../plugins/auth.js';
import { acceptOffer, declineOffer } from '../assignment/engine.js';
import { cancelByProvider, completeVisit, markArrived, onMyWay, recordActuals, recordVideoJoin, startVisit } from '../visits/service.js';
import { ratingSummary } from '../requests/ratings.js';
import { approvedBio, providerCredentials } from './profile.js';
import { acceptTerms, currentTerms, hasAcceptedCurrentTerms, loadProvider, recordPings, setDuty, setLocationConsent } from './service.js';

export default async function providerRoutes(fastify: FastifyInstance, ctx: Ctx) {
  const app = typed(fastify);

  app.post('/provider/location-consent', { schema: { tags: ['provider'], body: z.object({ granted: z.boolean() }) } }, async (req) =>
    setLocationConsent(ctx, requireProviderId(req), req.body.granted),
  );

  app.get('/provider/terms/current', { schema: { tags: ['provider'] } }, async (req) => {
    const pid = requireProviderId(req);
    const p = await loadProvider(ctx, pid);
    const t = await currentTerms(ctx, p.role);
    if (!t) throw new AppError('NOT_FOUND', 'No terms published for your role');
    return { ...t, accepted: await hasAcceptedCurrentTerms(ctx, pid, p.role) };
  });

  app.post('/provider/terms/accept', { schema: { tags: ['provider'], body: z.object({ version: z.number().int() }) } }, async (req) => {
    const m = clientMeta(req);
    return acceptTerms(ctx, requireProviderId(req), req.body.version, m.device, m.ip);
  });

  app.post('/provider/duty', { schema: { tags: ['provider'], body: z.object({ on: z.boolean() }) } }, async (req) => setDuty(ctx, requireProviderId(req), req.body.on));

  app.post(
    '/provider/location',
    {
      schema: {
        tags: ['provider'],
        body: z.object({
          pings: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), recorded_at: z.string().datetime() })).min(1).max(120),
        }),
      },
    },
    async (req) => recordPings(ctx, requireProviderId(req), req.body.pings),
  );

  app.get('/provider/today', { schema: { tags: ['provider'] } }, async (req) => {
    const pid = requireProviderId(req);
    const session = await maybeOne(ctx.db, 'SELECT on_duty, location_consent_at, active_job_id FROM provider_sessions WHERE provider_id=$1', [pid]);
    const pending = await many(
      ctx.db,
      `SELECT ra.request_id, ra.role_in_visit, ra.expires_at AS respond_by, ra.eta_minutes, ra.distance_m, sr.service_code, s.name AS service_name,
              z.name AS area
       FROM request_assignments ra JOIN service_requests sr ON sr.id=ra.request_id JOIN services s ON s.code=sr.service_code
       LEFT JOIN addresses a ON a.id=sr.address_id
       LEFT JOIN LATERAL (SELECT name FROM service_zones z WHERE a.pincode = ANY(z.pincodes) OR ST_Covers(z.area, a.location) LIMIT 1) z ON true
       WHERE ra.provider_id=$1 AND ra.outcome='offered' AND ra.expires_at > now() ORDER BY ra.offered_at`,
      [pid],
    );
    // One row per visit occurrence (series visits appear individually), today and the next 7 days.
    const visits = await many(
      ctx.db,
      `SELECT sr.id AS request_id, sr.status, sr.service_code, s.name AS service_name, ra.role_in_visit,
              o.seq AS visit_seq, (SELECT max(seq) FROM visit_occurrences WHERE request_id=sr.id) AS visit_count,
              o.scheduled_for, o.status AS visit_status
       FROM request_assignments ra JOIN service_requests sr ON sr.id=ra.request_id JOIN services s ON s.code=sr.service_code
       JOIN visit_occurrences o ON o.request_id=sr.id
       WHERE ra.provider_id=$1 AND ra.outcome='accepted' AND sr.status IN ('confirmed','provider_arrived','in_progress')
         AND (o.status='in_progress' OR (o.status='scheduled' AND (o.scheduled_for IS NULL
              OR (o.scheduled_for AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + 7)))
       ORDER BY COALESCE(o.scheduled_for, sr.created_at), o.seq`,
      [pid],
    );
    const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const isToday = (v: any) => !v.scheduled_for || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(v.scheduled_for) <= todayIst;
    // Only the next open visit of each request is actionable.
    const next = visits.filter((v, i) => visits.findIndex((w) => w.request_id === v.request_id) === i);
    return {
      on_duty: Boolean(session?.on_duty),
      location_consent: Boolean(session?.location_consent_at),
      pending_requests: pending.map((p) => ({ ...p, distance_km: p.distance_m != null ? Math.round(p.distance_m / 100) / 10 : null, distance_m: undefined })),
      ongoing_visit:
        next.find((v) => v.request_id === session?.active_job_id) ?? next.find((v) => ['provider_arrived', 'in_progress'].includes(v.status)) ?? null,
      schedule: visits.filter(isToday),
      upcoming: visits.filter((v) => !isToday(v)),
    };
  });

  /** Before acceptance: area and distance only. After acceptance: full address, gate code, symptoms. */
  app.get('/provider/requests/:id', { schema: { tags: ['provider'], params: IdParams } }, async (req) => {
    const pid = requireProviderId(req);
    const a = await maybeOne(
      ctx.db,
      `SELECT ra.* FROM request_assignments ra WHERE ra.request_id=$1 AND ra.provider_id=$2 ORDER BY ra.offered_at DESC LIMIT 1`,
      [req.params.id, pid],
    );
    if (!a || !['offered', 'accepted'].includes(a.outcome)) throw new AppError('NOT_FOUND', 'Request not found');
    const sr = await one(ctx.db, 'SELECT * FROM service_requests WHERE id=$1', [req.params.id]);
    const svc = await one(ctx.db, 'SELECT name FROM services WHERE code=$1', [sr.service_code]);
    const addr = await one(ctx.db, 'SELECT * FROM addresses WHERE id=$1', [sr.address_id]);
    const zone = await maybeOne(ctx.db, `SELECT name FROM service_zones WHERE $1 = ANY(pincodes) OR ST_Covers(area, (SELECT location FROM addresses WHERE id=$2)) LIMIT 1`, [addr.pincode, addr.id]);
    const patient = await one(ctx.db, 'SELECT name, dob, sex FROM patients WHERE id=$1', [sr.patient_id]);
    const base = {
      request_id: sr.id,
      status: sr.status,
      service_code: sr.service_code,
      service_name: svc.name,
      options: sr.options,
      role_in_visit: a.role_in_visit,
      emergency: sr.emergency,
      scheduled_for: sr.scheduled_for,
      area: { name: zone?.name ?? null, locality: addr.locality, pincode: addr.pincode },
      distance_km: a.distance_m != null ? Math.round(a.distance_m / 100) / 10 : null,
      eta_minutes: a.eta_minutes,
      patient: { age_years: patient.dob ? ageYears(patient.dob) : null, sex: patient.sex },
    };
    if (a.outcome !== 'accepted') return { ...base, accepted: false, respond_by: a.expires_at };

    const booker = await one(ctx.db, 'SELECT phone_e164 FROM users WHERE id=$1', [sr.booked_by_user_id]);
    const attachments = await many(ctx.db, 'SELECT kind, blob_key FROM request_attachments WHERE request_id=$1', [sr.id]);
    await ctx.db.query(
      `INSERT INTO record_access_log (actor_user_id, patient_id, resource_type, resource_id, outcome, reason, ip) VALUES ($1,$2,'service_request',$3,'allowed','assigned_provider',$4)`,
      [req.auth.userId, sr.patient_id, sr.id, req.ip],
    );
    const video = await maybeOne(ctx.db, 'SELECT room_id, purpose, starts_at FROM video_sessions WHERE request_id=$1 AND provider_id=$2', [sr.id, pid]);
    return {
      ...base,
      accepted: true,
      patient: { ...base.patient, name: patient.name, contact_phone: booker.phone_e164 },
      address: { label: addr.label, line1: addr.line1, landmark: addr.landmark, locality: addr.locality, pincode: addr.pincode, floor: addr.floor, lift: addr.lift, gate_code: addr.gate_code },
      symptoms: ctx.cipher.decryptJson<string[]>(sr.symptoms_enc, []),
      note: sr.note_enc ? ctx.cipher.decrypt(sr.note_enc) : null,
      attachments: await Promise.all(attachments.map(async (x) => ({ kind: x.kind, url: await ctx.adapters.storage.presignGet(x.blob_key) }))),
      video_session: video,
      visits: await many(ctx.db, 'SELECT seq, scheduled_for, status FROM visit_occurrences WHERE request_id=$1 ORDER BY seq', [sr.id]),
      estimated_items: (sr.line_items as any[]).filter((l) => l.estimate).map((l) => ({ option_code: l.option_code, name: l.name, quoted_paise: l.amount_paise })),
    };
  });

  app.post(
    '/provider/requests/:id/accept',
    { config: { idempotent: true }, schema: { tags: ['provider'], params: IdParams, body: z.object({ supervision_mode: z.enum(['present', 'remote']).optional() }).default({}) } },
    async (req) => acceptOffer(ctx, requireProviderId(req), req.params.id, req.body ?? {}),
  );

  app.post(
    '/provider/requests/:id/decline',
    { config: { idempotent: true }, schema: { tags: ['provider'], params: IdParams, body: z.object({ reason: z.string().min(1).max(300) }) } },
    async (req) => declineOffer(ctx, requireProviderId(req), req.params.id, req.body.reason),
  );

  app.post('/provider/visits/:id/arrived', { schema: { tags: ['provider'], params: IdParams, body: z.object({ visit_code: z.string().regex(/^\d{4}$/) }) } }, async (req) =>
    markArrived(ctx, requireProviderId(req), req.params.id, req.body.visit_code),
  );
  app.post(
    '/provider/requests/:id/cancel',
    { config: { idempotent: true }, schema: { tags: ['provider'], params: IdParams, body: z.object({ reason: z.string().min(3).max(300) }) } },
    async (req) => cancelByProvider(ctx, requireProviderId(req), req.params.id, req.body.reason),
  );

  app.post('/provider/visits/:id/on-my-way', { schema: { tags: ['provider'], params: IdParams } }, async (req) => onMyWay(ctx, requireProviderId(req), req.params.id));

  app.post(
    '/provider/visits/:id/actuals',
    {
      schema: {
        tags: ['provider'],
        params: IdParams,
        body: z.object({ items: z.array(z.object({ option_code: z.string(), actual_paise: z.number().int().min(0), note: z.string().max(200).optional() })).min(1).max(10) }),
      },
    },
    async (req) => recordActuals(ctx, requireProviderId(req), req.params.id, req.body.items),
  );

  app.post('/provider/visits/:id/start', { schema: { tags: ['provider'], params: IdParams } }, async (req) => startVisit(ctx, requireProviderId(req), req.params.id));
  app.post('/provider/visits/:id/complete', { config: { idempotent: true }, schema: { tags: ['provider'], params: IdParams } }, async (req) =>
    completeVisit(ctx, requireProviderId(req), req.params.id),
  );
  app.post('/provider/visits/:id/video/join', { schema: { tags: ['provider'], params: IdParams } }, async (req) => recordVideoJoin(ctx, requireProviderId(req), req.params.id));

  app.get('/provider/visits', { schema: { tags: ['provider'], querystring: z.object({ range: z.enum(['today', 'week', 'month']).default('week') }) } }, async (req) => {
    const pid = requireProviderId(req);
    const days = { today: 1, week: 7, month: 30 }[req.query.range];
    const rows = await many(
      ctx.db,
      `SELECT sr.id AS request_id, sr.service_code, s.name AS service_name, sr.status, ra.role_in_visit, sr.scheduled_for, sr.created_at,
              (SELECT COALESCE(sum(net_paise),0)::int FROM payout_lines pl WHERE pl.request_id=sr.id AND pl.provider_id=$1) AS earned_paise
       FROM request_assignments ra JOIN service_requests sr ON sr.id=ra.request_id JOIN services s ON s.code=sr.service_code
       WHERE ra.provider_id=$1 AND ra.outcome='accepted' AND sr.created_at > now() - make_interval(days => $2)
       ORDER BY sr.created_at DESC`,
      [pid, days],
    );
    return { range: req.query.range, visits: rows };
  });

  app.get('/provider/profile', { schema: { tags: ['provider'] } }, async (req) => {
    const pid = requireProviderId(req);
    const p = await loadProvider(ctx, pid);
    const pendingBio = await maybeOne(ctx.db, `SELECT text, moderation_status, created_at FROM provider_bios WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [pid]);
    const responsibilities = await maybeOne(ctx.db, `SELECT content FROM content_blocks WHERE key='provider_responsibilities'`);
    return {
      id: p.id,
      name: p.name,
      phone: p.phone_e164,
      role: p.role,
      reg_type: p.reg_type,
      reg_number: p.reg_number,
      credentials: providerCredentials(p),
      qualifications: p.qualifications,
      specialities: p.specialities,
      languages: p.languages,
      years_experience: p.years_experience,
      verification_status: p.verification_status,
      rating_avg: p.rating_avg,
      ratings: await ratingSummary(ctx, pid),
      bio: { published: await approvedBio(ctx.db, pid), latest_submission: pendingBio },
      responsibilities: responsibilities?.content ?? null,
      partner_desk_phone: ctx.config.env.PARTNER_DESK_PHONE,
      terms_accepted: await hasAcceptedCurrentTerms(ctx, pid, p.role),
    };
  });

  app.patch(
    '/provider/profile',
    {
      schema: {
        tags: ['provider'],
        body: z.object({
          languages: z.array(z.string().max(30)).max(10).optional(),
          qualifications: z.array(z.string().max(60)).max(10).optional(),
          specialities: z.array(z.string().max(60)).max(10).optional(),
          years_experience: z.number().int().min(0).max(70).optional(),
        }),
      },
    },
    async (req) => {
      const pid = requireProviderId(req);
      const b = req.body;
      await ctx.db.query(
        `UPDATE providers SET languages=COALESCE($2,languages), qualifications=COALESCE($3,qualifications),
           specialities=COALESCE($4,specialities), years_experience=COALESCE($5,years_experience) WHERE id=$1`,
        [pid, b.languages ?? null, b.qualifications ?? null, b.specialities ?? null, b.years_experience ?? null],
      );
      return { ok: true };
    },
  );

  app.put('/provider/bio', { schema: { tags: ['provider'], body: z.object({ text: z.string().trim().min(1).max(500) }) } }, async (req) => {
    const pid = requireProviderId(req);
    const b = await one(ctx.db, `INSERT INTO provider_bios (provider_id, text) VALUES ($1,$2) RETURNING id, text, moderation_status, created_at`, [pid, req.body.text]);
    return b; // shown to patients only after moderation
  });

  /** Registration certificate / ID for verification (upload via /uploads/presign kind=provider_document first). */
  app.post(
    '/provider/documents',
    { schema: { tags: ['provider'], body: z.object({ kind: z.enum(['registration_certificate', 'id_proof', 'training_certificate', 'other']), blob_key: z.string() }) } },
    async (req, reply) => {
      const pid = requireProviderId(req);
      const up = await maybeOne(ctx.db, `SELECT 1 FROM uploads WHERE blob_key=$1 AND owner_user_id=$2 AND kind='provider_document'`, [req.body.blob_key, req.auth.userId]);
      if (!up) throw new AppError('VALIDATION_ERROR', 'Upload not found');
      const d = await one(ctx.db, 'INSERT INTO provider_documents (provider_id, kind, blob_key) VALUES ($1,$2,$3) RETURNING id, kind, created_at', [pid, req.body.kind, req.body.blob_key]);
      return reply.code(201).send(d);
    },
  );

  app.get('/provider/fees', { schema: { tags: ['provider'] } }, async (req) => {
    const pid = requireProviderId(req);
    const p = await loadProvider(ctx, pid);
    const rows = await many(
      ctx.db,
      `SELECT s.code AS service_code, s.name AS service_name, o.code AS option_code, o.name AS option_name, o.price_paise, o.unit, o.payout_rule
       FROM service_options o JOIN services s ON s.id=o.service_id WHERE o.active AND s.active AND o.payee_role=$1 ORDER BY s.sort_order, o.code`,
      [p.role],
    );
    return {
      role: p.role,
      fees: rows.map((r) => {
        const { net, fee } = splitPayout(r.price_paise, r.payout_rule as PayoutRule);
        return { service_code: r.service_code, service_name: r.service_name, item: r.option_name, unit: r.unit, patient_pays_paise: r.price_paise, platform_fee_paise: fee, you_receive_paise: net };
      }),
    };
  });

  app.get('/provider/payouts', { schema: { tags: ['provider'] } }, async (req) => {
    const pid = requireProviderId(req);
    const payouts = await many(ctx.db, 'SELECT id, period_start, period_end, gross_paise, platform_fee_paise, net_paise, status, sent_at FROM payouts WHERE provider_id=$1 ORDER BY period_end DESC LIMIT 52', [pid]);
    const pending = await one(
      ctx.db,
      'SELECT COALESCE(sum(gross_paise),0)::int AS gross, COALESCE(sum(platform_fee_paise),0)::int AS fee, COALESCE(sum(net_paise),0)::int AS net FROM payout_lines WHERE provider_id=$1 AND payout_id IS NULL',
      [pid],
    );
    return { unpaid: { gross_paise: pending.gross, platform_fee_paise: pending.fee, net_paise: pending.net }, payouts };
  });
}

function ageYears(dob: Date) {
  const d = new Date(dob);
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
