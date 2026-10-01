import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx, type Queryable, type TxClient } from '../../lib/db.js';
import { addMinutes, addSeconds } from '../../lib/time.js';
import type { LatLng } from '../../lib/geo.js';
import { notify } from '../notifications/service.js';
import { releaseAssignments, zoneForAddress } from '../requests/service.js';
import { transition } from '../requests/state.js';
import { estimateEta } from './eta.js';
import { clashSql, providerHasClash } from './clash.js';
import { issueVisitCode } from '../visits/service.js';

/** Due now (or within 2 hours), as opposed to booked for later. */
export const isImmediate = (sr: { scheduled_for: Date | null }) => !sr.scheduled_for || new Date(sr.scheduled_for).getTime() <= Date.now() + 2 * 3600_000;

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ta: 'Tamil', kn: 'Kannada', hi: 'Hindi' };

export interface Candidate {
  provider_id: string;
  user_id: string;
  name: string | null;
  languages: string[];
  rating: number;
  continuity: number;
  load: number;
  eta_minutes: number | null;
  distance_m: number | null;
  score: number;
}

/** Entry point (job `assignment.run`): move to `assigning` and make sure every open slot has a live offer. */
export async function runAssignment(ctx: Ctx, requestId: string) {
  const sr = await maybeOne(ctx.db, 'SELECT * FROM service_requests WHERE id=$1', [requestId]);
  if (!sr) return;
  if (sr.status === 'requested') {
    const triage = await maybeOne(ctx.db, `SELECT value FROM app_config WHERE key='triage_services'`);
    const needsReview = Array.isArray(triage?.value) && triage.value.includes(sr.service_code) && !sr.emergency;
    await tx(ctx.db, (c) => transition(ctx, c, requestId, needsReview ? 'reviewing' : 'assigning', { type: 'system' }));
    if (needsReview) return; // ops approves via /ops/requests/:id/approve
  } else if (sr.status !== 'assigning') {
    return;
  }

  const slots = await many(ctx.db, 'SELECT * FROM request_slots WHERE request_id=$1 AND filled_by_provider_id IS NULL', [requestId]);
  for (const slot of slots) {
    const live = await maybeOne(
      ctx.db,
      `SELECT 1 FROM request_assignments WHERE slot_id=$1 AND outcome='offered' AND expires_at > now()`,
      [slot.id],
    );
    if (live) continue;
    const candidates = await findCandidates(ctx, sr, slot);
    if (candidates.length === 0) {
      await tx(ctx.db, async (c) => {
        const cur = await one(c, 'SELECT status FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
        if (cur.status !== 'assigning') return;
        await releaseAssignments(ctx, c, requestId, 'withdrawn');
        await c.query('UPDATE request_slots SET filled_by_provider_id=NULL WHERE request_id=$1', [requestId]);
        await transition(ctx, c, requestId, 'no_provider', { type: 'system' }, { slot_role: slot.role });
      });
      return;
    }
    await createOffers(ctx, sr, slot, candidates.slice(0, ctx.config.assignment.offerFanout));
  }
}

async function patientContext(db: Queryable, sr: any) {
  return one(
    db,
    `SELECT a.id AS address_id, ST_Y(a.location::geometry) AS lat, ST_X(a.location::geometry) AS lng, u.preferred_language,
            s.promised_window_minutes
     FROM addresses a, users u, services s WHERE a.id=$1 AND u.id=$2 AND s.code=$3`,
    [sr.address_id, sr.booked_by_user_id, sr.service_code],
  );
}

/**
 * Candidates: on duty, location consent, verified, correct role, zone covers address, free (no active job),
 * not previously offered this request. Ranked by fit to window, then language, continuity, rating, load, ETA.
 */
export async function findCandidates(ctx: Ctx, sr: any, slot: any): Promise<Candidate[]> {
  const cfg = ctx.config.assignment;
  const pc = await patientContext(ctx.db, sr);
  const zone = await zoneForAddress(ctx.db, sr.address_id);
  if (!zone) return [];
  const rows = await many(
    ctx.db,
    `SELECT p.id AS provider_id, p.user_id, u.name, p.languages, COALESCE(p.rating_avg, 4.0) AS rating,
            ST_Y(s.last_location::geometry) AS lat, ST_X(s.last_location::geometry) AS lng,
            (SELECT count(*) FROM request_assignments ra JOIN service_requests r2 ON r2.id = ra.request_id
              WHERE ra.provider_id = p.id AND ra.outcome='accepted' AND r2.patient_id=$3 AND r2.status='completed') AS continuity,
            (SELECT count(*) FROM request_assignments ra WHERE ra.provider_id = p.id AND ra.outcome='offered' AND ra.expires_at > now()) AS load
     FROM providers p
     JOIN provider_sessions s ON s.provider_id = p.id
     JOIN users u ON u.id = p.user_id
     JOIN provider_terms_acceptances pta ON pta.provider_id = p.id AND pta.role = p.role
       AND pta.version = (SELECT max(version) FROM provider_terms WHERE role = p.role)
     WHERE p.role = $1 AND p.verification_status = 'verified' AND s.on_duty AND s.active_job_id IS NULL
       AND $2 = ANY(p.service_area_zone_ids)
       AND ($5 OR (s.location_consent_at IS NOT NULL AND s.last_location IS NOT NULL
                   AND s.last_location_at > now() - make_interval(secs => $6)))
       -- 'withdrawn' only means someone else took the slot; those providers can be offered it again.
       AND NOT EXISTS (SELECT 1 FROM request_assignments x WHERE x.request_id = $4 AND x.provider_id = p.id AND x.outcome <> 'withdrawn')
       -- No double-booking: skip anyone with an accepted visit that overlaps this one.
       AND NOT ${clashSql('p.id', '$4')}
     ORDER BY CASE WHEN $5 THEN 0 ELSE ST_Distance(s.last_location, (SELECT location FROM addresses WHERE id=$7)) END
     LIMIT $8`,
    [slot.role, zone.id, sr.patient_id, sr.id, slot.remote, ctx.config.duty.locationTtlSeconds, sr.address_id, cfg.maxCandidates],
  );

  const window = pc.promised_window_minutes ?? cfg.defaultWindowMinutes;
  const wantLang = LANGUAGE_NAMES[pc.preferred_language as string] ?? 'English';
  const dest: LatLng = { lat: pc.lat, lng: pc.lng };
  const out: Candidate[] = [];
  for (const r of rows) {
    let eta: number | null = null;
    let dist: number | null = null;
    if (!slot.remote) {
      const est = await estimateEta(ctx, { lat: r.lat, lng: r.lng }, dest);
      eta = est.minutes;
      dist = est.meters;
      if (!sr.scheduled_for && eta > window) continue; // must fit the promised window
    }
    const w = cfg.weights;
    const score =
      ((r.languages as string[]).includes(wantLang) ? w.language : 0) +
      Math.min(Number(r.continuity), 3) * (w.continuity / 3) +
      (Number(r.rating) / 5) * w.rating -
      Math.min(Number(r.load), 3) * (w.load / 3) -
      (eta !== null ? (eta / window) * w.eta : 0);
    out.push({
      provider_id: r.provider_id,
      user_id: r.user_id,
      name: r.name,
      languages: r.languages,
      rating: Number(r.rating),
      continuity: Number(r.continuity),
      load: Number(r.load),
      eta_minutes: eta,
      distance_m: dist,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function createOffers(ctx: Ctx, sr: any, slot: any, candidates: Candidate[]) {
  const expiresAt = addSeconds(new Date(), ctx.config.assignment.offerTtlSeconds);
  const svc = await one(ctx.db, 'SELECT name FROM services WHERE code=$1', [sr.service_code]);
  for (const cand of candidates) {
    const a = await one(
      ctx.db,
      `INSERT INTO request_assignments (request_id, slot_id, provider_id, role_in_visit, expires_at, eta_minutes, distance_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [sr.id, slot.id, cand.provider_id, slot.role_in_visit, expiresAt, cand.eta_minutes, cand.distance_m],
    );
    await ctx.realtime.publish(ctx.realtime.providerChannel(cand.provider_id), 'request.offer', {
      request_id: sr.id,
      assignment_id: a.id,
      service_code: sr.service_code,
      service_name: svc.name,
      role_in_visit: slot.role_in_visit,
      eta_minutes: cand.eta_minutes,
      distance_km: cand.distance_m !== null ? Math.round(cand.distance_m / 100) / 10 : null,
      respond_by: expiresAt.toISOString(),
    });
    await notify(ctx, cand.user_id, 'new_request_offer', { service: svc.name });
    await ctx.jobs.enqueue('assignment.offer_expiry', { assignmentId: a.id }, { delayMs: ctx.config.assignment.offerTtlSeconds * 1000, jobId: `offer-expiry:${a.id}` });
  }
}

const lockKey = (slotId: string) => `assign:lock:${slotId}`;

/**
 * Accept an offer. Exactly one provider can win a slot: Redis SET NX serialises contenders
 * fast, and a partial unique index (one accepted assignment per slot) is the durable guarantee.
 */
export async function acceptOffer(ctx: Ctx, providerId: string, requestId: string, opts: { supervision_mode?: 'present' | 'remote' } = {}) {
  const offer = await maybeOne(
    ctx.db,
    `SELECT ra.*, rs.filled_by_provider_id, rs.role AS slot_role, rs.remote FROM request_assignments ra
     JOIN request_slots rs ON rs.id = ra.slot_id
     WHERE ra.request_id=$1 AND ra.provider_id=$2 ORDER BY ra.offered_at DESC LIMIT 1`,
    [requestId, providerId],
  );
  if (!offer) throw new AppError('NOT_FOUND', 'No offer for this request');
  if (offer.outcome === 'accepted') return { request_id: requestId, outcome: 'accepted' as const };
  if (offer.filled_by_provider_id || offer.outcome === 'withdrawn') throw new AppError('ALREADY_ASSIGNED', 'Another professional has accepted this request');
  if (offer.outcome !== 'offered' || offer.expires_at <= new Date()) throw new AppError('OFFER_EXPIRED', 'This request is no longer available');

  const key = lockKey(offer.slot_id);
  const got = await ctx.redis.set(key, providerId, 'PX', 15000, 'NX');
  if (got !== 'OK') throw new AppError('ALREADY_ASSIGNED', 'Another professional has accepted this request');

  try {
    return await tx(ctx.db, async (c) => {
      const slot = await one(c, 'SELECT * FROM request_slots WHERE id=$1 FOR UPDATE', [offer.slot_id]);
      if (slot.filled_by_provider_id) throw new AppError('ALREADY_ASSIGNED', 'Another professional has accepted this request');
      const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
      if (sr.status !== 'assigning') throw new AppError('ALREADY_ASSIGNED', 'This request is no longer open');
      const session = await maybeOne(c, 'SELECT * FROM provider_sessions WHERE provider_id=$1 FOR UPDATE', [providerId]);
      if (!session?.on_duty) throw new AppError('NOT_ON_DUTY', 'Go on duty to accept requests');
      if (!slot.remote && session.active_job_id) throw new AppError('CONFLICT', 'Finish your current visit first');
      // Re-checked at accept: another booking may have been accepted since the offer went out.
      if (await providerHasClash(c, providerId, requestId)) throw new AppError('SCHEDULE_CLASH', 'This overlaps a visit you have already accepted');

      let roleInVisit = offer.role_in_visit as string;
      const remoteSupervision = slot.role === 'doctor' && sr.first_dose_mode === 'with_doctor' && opts.supervision_mode === 'remote';
      if (remoteSupervision) roleInVisit = 'remote_supervisor';

      await c.query(`UPDATE request_assignments SET outcome='accepted', responded_at=now(), role_in_visit=$2 WHERE id=$1`, [offer.id, roleInVisit]);
      await c.query('UPDATE request_slots SET filled_by_provider_id=$2 WHERE id=$1', [slot.id, providerId]);
      const losers = await many(
        c,
        `UPDATE request_assignments SET outcome='withdrawn', responded_at=now() WHERE slot_id=$1 AND outcome='offered' AND id<>$2 RETURNING provider_id`,
        [slot.id, offer.id],
      );
      // Only an immediate visit holds the provider now; a later one is held from "on my way".
      if (!slot.remote && !remoteSupervision && isImmediate(sr)) await c.query('UPDATE provider_sessions SET active_job_id=$2 WHERE provider_id=$1', [providerId, requestId]);

      if (remoteSupervision || slot.remote) {
        const startsAt = sr.scheduled_for ?? new Date();
        const room = await ctx.adapters.video.createRoom(remoteSupervision ? 'first_dose_monitoring' : 'specialist_consult', startsAt, addMinutes(startsAt, 60));
        await c.query(
          `INSERT INTO video_sessions (request_id, provider_id, purpose, room_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [requestId, providerId, remoteSupervision ? 'first_dose_monitoring' : 'specialist_consult', room.roomId, startsAt, addMinutes(startsAt, 60)],
        );
      }

      for (const l of losers) {
        c.afterCommit(() => ctx.realtime.publish(ctx.realtime.providerChannel(l.provider_id), 'request.taken', { request_id: requestId }));
      }

      const open = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM request_slots WHERE request_id=$1 AND filled_by_provider_id IS NULL', [requestId]);
      if (open.n === 0) await confirmRequest(ctx, c, sr);
      return { request_id: requestId, outcome: 'accepted' as const, role_in_visit: roleInVisit };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('ALREADY_ASSIGNED', 'Another professional has accepted this request');
    throw e;
  } finally {
    // The lock only serialises concurrent accepts; once committed, the slot row is the truth.
    // Released so a later re-assignment of the same slot (provider cancelled) is not blocked.
    if ((await ctx.redis.get(key)) === providerId) await ctx.redis.del(key);
  }
}

/** All slots filled: door code, first ETA, `confirmed`, patient notified with name + minutes only. */
async function confirmRequest(ctx: Ctx, c: TxClient, sr: any) {
  await issueVisitCode(ctx, c, sr.id);
  const lead = await maybeOne(
    c,
    `SELECT ra.provider_id, u.name, ST_Y(s.last_location::geometry) AS lat, ST_X(s.last_location::geometry) AS lng, rs.remote
     FROM request_assignments ra JOIN request_slots rs ON rs.id=ra.slot_id JOIN providers p ON p.id=ra.provider_id
     JOIN users u ON u.id=p.user_id JOIN provider_sessions s ON s.provider_id=p.id
     WHERE ra.request_id=$1 AND ra.outcome='accepted' AND NOT rs.remote AND ra.role_in_visit <> 'remote_supervisor'
     ORDER BY (ra.role_in_visit='lead') DESC LIMIT 1`,
    [sr.id],
  );
  let minutes: number | null = null;
  if (lead?.lat != null && isImmediate(sr)) {
    const addr = await one(c, 'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM addresses WHERE id=$1', [sr.address_id]);
    minutes = (await estimateEta(ctx, { lat: lead.lat, lng: lead.lng }, { lat: addr.lat, lng: addr.lng })).minutes;
    await c.query('UPDATE service_requests SET eta_minutes=$2, expected_by=$3 WHERE id=$1', [sr.id, minutes, addMinutes(new Date(), minutes)]);
  }
  await transition(ctx, c, sr.id, 'confirmed', { type: 'system' });
  const anyName = lead?.name ?? (await maybeOne(c, `SELECT u.name FROM request_assignments ra JOIN providers p ON p.id=ra.provider_id JOIN users u ON u.id=p.user_id WHERE ra.request_id=$1 AND ra.outcome='accepted' LIMIT 1`, [sr.id]))?.name;
  c.afterCommit(() => notify(ctx, sr.booked_by_user_id, 'request_confirmed', { name: anyName ?? 'Your care professional', minutes: minutes ?? '—' }));
}

export async function declineOffer(ctx: Ctx, providerId: string, requestId: string, reason: string) {
  const r = await ctx.db.query(
    `UPDATE request_assignments SET outcome='declined', responded_at=now(), decline_reason=$3
     WHERE request_id=$1 AND provider_id=$2 AND outcome='offered' RETURNING id`,
    [requestId, providerId, reason],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'No open offer for this request');
  await ctx.jobs.enqueue('assignment.run', { requestId });
  return { request_id: requestId, outcome: 'declined' };
}

/** Job: an offer's 10 minutes are up with no answer. */
export async function expireOffer(ctx: Ctx, assignmentId: string) {
  const r = await maybeOne(
    ctx.db,
    `UPDATE request_assignments SET outcome='expired', responded_at=now() WHERE id=$1 AND outcome='offered' AND expires_at <= now() RETURNING request_id`,
    [assignmentId],
  );
  if (r) await runAssignment(ctx, r.request_id);
}

/** Ops manual assignment: bypasses ranking but not verification. */
export async function manualAssign(ctx: Ctx, requestId: string, slotId: string, providerId: string) {
  const p = await maybeOne(ctx.db, `SELECT p.*, rs.role AS slot_role, rs.role_in_visit FROM providers p, request_slots rs WHERE p.id=$1 AND rs.id=$2 AND rs.request_id=$3`, [providerId, slotId, requestId]);
  if (!p) throw new AppError('NOT_FOUND', 'Provider or slot not found');
  if (p.verification_status !== 'verified') throw new AppError('PROVIDER_NOT_VERIFIED', 'Provider is not verified');
  if (p.role !== p.slot_role) throw new AppError('VALIDATION_ERROR', `Slot needs a ${p.slot_role}`);
  await tx(ctx.db, async (c) => {
    const sr = await one(c, 'SELECT status FROM service_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (['requested', 'reviewing', 'no_provider'].includes(sr.status)) await transition(ctx, c, requestId, 'assigning', { type: 'ops' });
    await c.query(`UPDATE request_assignments SET outcome='withdrawn', responded_at=now() WHERE slot_id=$1 AND outcome='offered'`, [slotId]);
    await c.query(
      `INSERT INTO request_assignments (request_id, slot_id, provider_id, role_in_visit, expires_at, assigned_by) VALUES ($1,$2,$3,$4,$5,'ops')`,
      [requestId, slotId, providerId, p.role_in_visit, addSeconds(new Date(), ctx.config.assignment.offerTtlSeconds)],
    );
  });
  const u = await one(ctx.db, 'SELECT user_id FROM providers WHERE id=$1', [providerId]);
  await ctx.realtime.publish(ctx.realtime.providerChannel(providerId), 'request.offer', { request_id: requestId, assigned_by: 'ops' });
  await notify(ctx, u.user_id, 'new_request_offer', { service: 'KM DocH' });
  return { request_id: requestId, offered_to: providerId };
}
