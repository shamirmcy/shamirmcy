import type { FastifyRequest } from 'fastify';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one, tx, type Queryable } from '../../lib/db.js';
import { formatIST } from '../../lib/time.js';
import { assertAssignedProvider, assertRecordAccess } from '../access.js';
import { notify } from '../notifications/service.js';
import { PRESCRIBER_ROLES, type ProviderRole } from '../providers/roles.js';

// ───────────────────────────── Consultations ─────────────────────────────

export interface ConsultationInput {
  request_id: string;
  vitals?: Record<string, number | string>;
  notes?: string;
  diagnosis?: string;
  advice?: string;
  follow_up_at?: string;
}

export async function createConsultation(ctx: Ctx, providerId: string, input: ConsultationInput) {
  await assertAssignedProvider(ctx.db, providerId, input.request_id);
  const sr = await one(ctx.db, 'SELECT * FROM service_requests WHERE id=$1', [input.request_id]);
  if (!['provider_arrived', 'in_progress', 'completed', 'confirmed'].includes(sr.status)) throw new AppError('INVALID_TRANSITION', 'Visit has not started');
  const p = await one(ctx.db, 'SELECT role FROM providers WHERE id=$1', [providerId]);
  // Psychiatry notes are visible to the consultant only.
  const restricted = sr.service_code === 'specialist_visit' && sr.options?.specialty === 'psychiatry' && p.role === 'consultant';
  const c = await one(
    ctx.db,
    `INSERT INTO consultations (request_id, patient_id, provider_id, vitals_enc, notes_enc, diagnosis_enc, advice_enc, restricted, follow_up_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
    [
      sr.id,
      sr.patient_id,
      providerId,
      ctx.cipher.encryptJson(input.vitals ?? null),
      input.notes ? ctx.cipher.encrypt(input.notes) : null,
      input.diagnosis ? ctx.cipher.encrypt(input.diagnosis) : null,
      input.advice ? ctx.cipher.encrypt(input.advice) : null,
      restricted,
      input.follow_up_at ?? null,
    ],
  );
  return { id: c.id as string, request_id: sr.id, restricted, created_at: c.created_at };
}

export async function updateConsultation(ctx: Ctx, providerId: string, id: string, input: Omit<ConsultationInput, 'request_id'>) {
  const c = await maybeOne(ctx.db, 'SELECT * FROM consultations WHERE id=$1', [id]);
  if (!c || c.provider_id !== providerId) throw new AppError('NOT_FOUND', 'Consultation not found');
  const signed = await maybeOne(ctx.db, `SELECT 1 FROM prescriptions WHERE consultation_id=$1 AND status <> 'draft'`, [id]);
  if (signed && (input.diagnosis !== undefined || input.notes !== undefined)) {
    throw new AppError('PRESCRIPTION_LOCKED', 'Diagnosis and notes are locked once a prescription is signed; add an addendum consultation instead');
  }
  await ctx.db.query(
    `UPDATE consultations SET vitals_enc=COALESCE($2,vitals_enc), notes_enc=COALESCE($3,notes_enc), diagnosis_enc=COALESCE($4,diagnosis_enc),
       advice_enc=COALESCE($5,advice_enc), follow_up_at=COALESCE($6,follow_up_at) WHERE id=$1`,
    [
      id,
      input.vitals ? ctx.cipher.encryptJson(input.vitals) : null,
      input.notes ? ctx.cipher.encrypt(input.notes) : null,
      input.diagnosis ? ctx.cipher.encrypt(input.diagnosis) : null,
      input.advice ? ctx.cipher.encrypt(input.advice) : null,
      input.follow_up_at ?? null,
    ],
  );
  return { id, updated: true };
}

/** Decrypt a consultation for a viewer. Restricted notes are only shown to their author. */
export function decryptConsultation(ctx: Ctx, c: any, viewerProviderId?: string) {
  const showNotes = !c.restricted || c.provider_id === viewerProviderId;
  return {
    id: c.id,
    request_id: c.request_id,
    provider_id: c.provider_id,
    vitals: ctx.cipher.decryptJson<Record<string, unknown> | null>(c.vitals_enc, null),
    notes: showNotes && c.notes_enc ? ctx.cipher.decrypt(c.notes_enc) : null,
    notes_restricted: !showNotes,
    diagnosis: c.diagnosis_enc ? ctx.cipher.decrypt(c.diagnosis_enc) : null,
    advice: c.advice_enc ? ctx.cipher.decrypt(c.advice_enc) : null,
    follow_up_at: c.follow_up_at,
    created_at: c.created_at,
  };
}

// ───────────────────────────── Prescriptions ─────────────────────────────

export interface RxItemInput {
  drug: string;
  strength?: string;
  pattern?: string;
  days?: number;
  timing?: string;
  sos?: boolean;
  instructions?: string;
}

export interface PrescriptionInput {
  consultation_id: string;
  mode: 'typed' | 'photo';
  items?: RxItemInput[];
  photo_keys?: string[];
  supersedes_id?: string;
}

async function assertPrescriber(db: Queryable, providerId: string) {
  const p = await one(db, 'SELECT role, verification_status FROM providers WHERE id=$1', [providerId]);
  if (!PRESCRIBER_ROLES.includes(p.role as ProviderRole)) throw new AppError('FORBIDDEN', 'Only doctors can write prescriptions');
  if (p.verification_status !== 'verified') throw new AppError('PROVIDER_NOT_VERIFIED', 'Provider not verified');
}

export async function createPrescription(ctx: Ctx, providerId: string, userId: string, input: PrescriptionInput) {
  await assertPrescriber(ctx.db, providerId);
  const cons = await maybeOne(ctx.db, 'SELECT * FROM consultations WHERE id=$1', [input.consultation_id]);
  if (!cons) throw new AppError('NOT_FOUND', 'Consultation not found');
  await assertAssignedProvider(ctx.db, providerId, cons.request_id);

  if (input.mode === 'typed' && !input.items?.length) throw new AppError('VALIDATION_ERROR', 'Typed prescriptions need at least one item');
  if (input.mode === 'photo' && (!input.photo_keys?.length || input.photo_keys.length > 5)) throw new AppError('VALIDATION_ERROR', 'Upload 1 to 5 prescription pages');

  return tx(ctx.db, async (c) => {
    let version = 1;
    if (input.supersedes_id) {
      const old = await maybeOne(c, 'SELECT * FROM prescriptions WHERE id=$1 FOR UPDATE', [input.supersedes_id]);
      if (!old || old.patient_id !== cons.patient_id) throw new AppError('NOT_FOUND', 'Prescription to supersede not found');
      if (old.status !== 'signed') throw new AppError('VALIDATION_ERROR', 'Only a signed prescription can be superseded');
      if (await maybeOne(c, 'SELECT 1 FROM prescriptions WHERE supersedes_id=$1', [old.id])) throw new AppError('CONFLICT', 'A correction already exists for this prescription');
      version = old.version + 1;
    }
    const rx = await one(
      c,
      `INSERT INTO prescriptions (consultation_id, patient_id, prescriber_id, version, supersedes_id, mode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cons.id, cons.patient_id, providerId, version, input.supersedes_id ?? null, input.mode],
    );
    if (input.mode === 'typed') {
      for (const [i, it] of input.items!.entries()) {
        await c.query(
          `INSERT INTO prescription_items (prescription_id, position, drug, strength, pattern, days, timing, sos, instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rx.id, i + 1, it.drug, it.strength ?? null, it.pattern ?? null, it.days ?? null, it.timing ?? null, Boolean(it.sos), it.instructions ?? null],
        );
      }
      await computeAlerts(ctx, c, rx.id, cons.patient_id, input.items!);
    } else {
      for (const [i, key] of input.photo_keys!.entries()) {
        const up = await maybeOne(c, `SELECT * FROM uploads WHERE blob_key=$1 AND owner_user_id=$2 AND kind='prescription_photo'`, [key, userId]);
        if (!up) throw new AppError('VALIDATION_ERROR', `Upload ${key} not found`);
        await c.query('INSERT INTO prescription_photos (prescription_id, page_no, blob_key) VALUES ($1,$2,$3)', [rx.id, i + 1, key]);
      }
      c.afterCommit(() => ctx.jobs.enqueue('prescription.ocr', { prescriptionId: rx.id }));
    }
    const alerts = await many(c, 'SELECT id, severity, message FROM clinical_alerts WHERE prescription_id=$1', [rx.id]);
    return { id: rx.id as string, version, status: 'draft', mode: input.mode, alerts };
  });
}

/** Drug–condition / drug–allergy / drug–drug rules against the patient's profile and active prescriptions. */
async function computeAlerts(ctx: Ctx, c: Queryable, rxId: string, patientId: string, items: RxItemInput[]) {
  const patient = await one(c, 'SELECT conditions_enc, allergies_enc FROM patients WHERE id=$1', [patientId]);
  const conditions = ctx.cipher.decryptJson<string[]>(patient.conditions_enc, []).map((s) => s.toLowerCase());
  const allergies = ctx.cipher.decryptJson<string[]>(patient.allergies_enc, []).map((s) => s.toLowerCase());
  const activeDrugs = (
    await many(
      c,
      `SELECT pi.drug FROM prescription_items pi JOIN prescriptions p ON p.id=pi.prescription_id
       WHERE p.patient_id=$1 AND p.status='signed' AND p.signed_at > now() - make_interval(days => COALESCE(pi.days, 30))`,
      [patientId],
    )
  ).map((r) => r.drug as string);
  const rules = await many(c, 'SELECT * FROM clinical_rules WHERE active');
  const seen = new Set<string>();
  for (const it of items) {
    for (const r of rules) {
      if (!new RegExp(r.drug_pattern, 'i').test(it.drug)) continue;
      const m = String(r.match_value).toLowerCase();
      const hit =
        (r.kind === 'drug_condition' && conditions.some((x) => x.includes(m))) ||
        (r.kind === 'drug_allergy' && allergies.some((x) => x.includes(m))) ||
        (r.kind === 'drug_drug' && [...activeDrugs, ...items.filter((x) => x !== it).map((x) => x.drug)].some((d) => new RegExp(r.match_value, 'i').test(d)));
      if (hit && !seen.has(r.id)) {
        seen.add(r.id);
        await c.query('INSERT INTO clinical_alerts (prescription_id, rule_id, severity, message) VALUES ($1,$2,$3,$4)', [rxId, r.id, r.severity, r.message]);
      }
    }
  }
}

export async function signPrescription(ctx: Ctx, providerId: string, rxId: string) {
  return tx(ctx.db, async (c) => {
    const rx = await maybeOne(c, 'SELECT * FROM prescriptions WHERE id=$1 FOR UPDATE', [rxId]);
    if (!rx || rx.prescriber_id !== providerId) throw new AppError('NOT_FOUND', 'Prescription not found');
    if (rx.status !== 'draft') throw new AppError('PRESCRIPTION_LOCKED', 'Prescription already signed');
    if (rx.mode === 'photo') {
      const bad = await maybeOne(c, `SELECT 1 FROM prescription_photos WHERE prescription_id=$1 AND quality_status='rejected'`, [rxId]);
      if (bad) throw new AppError('VALIDATION_ERROR', 'A page failed the quality check; re-upload it');
    }
    await c.query(`UPDATE prescriptions SET status='signed', signed_at=now() WHERE id=$1`, [rxId]);
    if (rx.supersedes_id) await c.query(`UPDATE prescriptions SET status='superseded' WHERE id=$1`, [rx.supersedes_id]);
    const sr = await one(c, 'SELECT sr.booked_by_user_id FROM consultations co JOIN service_requests sr ON sr.id=co.request_id WHERE co.id=$1', [rx.consultation_id]);
    c.afterCommit(async () => {
      await ctx.jobs.enqueue('prescription.pdf', { prescriptionId: rxId });
      await notify(ctx, sr.booked_by_user_id, 'prescription_ready', {});
    });
    return { id: rxId, status: 'signed' as const };
  });
}

/** Typed drafts may be edited before signing; signed ones never (DB triggers enforce this too). */
export async function replaceDraftItems(ctx: Ctx, providerId: string, rxId: string, items: RxItemInput[]) {
  return tx(ctx.db, async (c) => {
    const rx = await maybeOne(c, 'SELECT * FROM prescriptions WHERE id=$1 FOR UPDATE', [rxId]);
    if (!rx || rx.prescriber_id !== providerId) throw new AppError('NOT_FOUND', 'Prescription not found');
    if (rx.status !== 'draft') throw new AppError('PRESCRIPTION_LOCKED', 'Signed prescriptions cannot be edited; create a correction that supersedes it');
    if (rx.mode !== 'typed') throw new AppError('VALIDATION_ERROR', 'Photo prescriptions have no typed items');
    await c.query('DELETE FROM prescription_items WHERE prescription_id=$1', [rxId]);
    await c.query('DELETE FROM clinical_alerts WHERE prescription_id=$1', [rxId]);
    for (const [i, it] of items.entries()) {
      await c.query(
        `INSERT INTO prescription_items (prescription_id, position, drug, strength, pattern, days, timing, sos, instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rxId, i + 1, it.drug, it.strength ?? null, it.pattern ?? null, it.days ?? null, it.timing ?? null, Boolean(it.sos), it.instructions ?? null],
      );
    }
    await computeAlerts(ctx, c, rxId, rx.patient_id, items);
    return { id: rxId, status: 'draft', alerts: await many(c, 'SELECT id, severity, message FROM clinical_alerts WHERE prescription_id=$1', [rxId]) };
  });
}

/** Doctor confirms the pharmacist's transcription of a photo prescription. Required before dispatch. */
export async function confirmTranscription(ctx: Ctx, providerId: string, rxId: string) {
  const rx = await maybeOne(ctx.db, 'SELECT * FROM prescriptions WHERE id=$1', [rxId]);
  if (!rx || rx.prescriber_id !== providerId) throw new AppError('NOT_FOUND', 'Prescription not found');
  if (rx.mode !== 'photo') throw new AppError('VALIDATION_ERROR', 'Only photo prescriptions are transcribed');
  const pending = await maybeOne(ctx.db, 'SELECT 1 FROM prescription_photos WHERE prescription_id=$1 AND transcribed_at IS NULL', [rxId]);
  if (pending) throw new AppError('TRANSCRIPTION_PENDING', 'The pharmacist has not finished transcribing all pages');
  await ctx.db.query('UPDATE prescription_photos SET provider_confirmed_at=now() WHERE prescription_id=$1 AND provider_confirmed_at IS NULL', [rxId]);
  await ctx.db.query('UPDATE prescriptions SET transcription_confirmed_at=now() WHERE id=$1 AND transcription_confirmed_at IS NULL', [rxId]);
  return { id: rxId, transcription_confirmed: true };
}

export async function getTranscription(ctx: Ctx, providerId: string, rxId: string) {
  const rx = await maybeOne(ctx.db, 'SELECT * FROM prescriptions WHERE id=$1', [rxId]);
  if (!rx || rx.prescriber_id !== providerId) throw new AppError('NOT_FOUND', 'Prescription not found');
  const pages = await many(ctx.db, 'SELECT page_no, quality_status, quality_reason, pharmacist_transcribed_items, transcribed_at, provider_confirmed_at FROM prescription_photos WHERE prescription_id=$1 ORDER BY page_no', [rxId]);
  return { id: rxId, pages };
}

/** Pharmacist (pharmacy partner member) transcribes a page. */
export async function transcribePage(ctx: Ctx, pharmacistUserId: string, rxId: string, pageNo: number, items: RxItemInput[]) {
  const r = await maybeOne(
    ctx.db,
    `UPDATE prescription_photos SET pharmacist_transcribed_items=$3, transcribed_by=$4, transcribed_at=now()
     WHERE prescription_id=$1 AND page_no=$2 AND provider_confirmed_at IS NULL RETURNING id`,
    [rxId, pageNo, JSON.stringify(items), pharmacistUserId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'Page not found or already confirmed');
  return { prescription_id: rxId, page_no: pageNo, transcribed: true };
}

/** Medicines may be dispatched against a prescription only once it is signed (and, for photos, transcription confirmed). */
export async function assertDispatchable(db: Queryable, rxId: string, patientId: string) {
  const rx = await maybeOne(db, 'SELECT * FROM prescriptions WHERE id=$1 AND patient_id=$2', [rxId, patientId]);
  if (!rx || rx.status !== 'signed') throw new AppError('PRESCRIPTION_REQUIRED', 'A signed prescription for this patient is required');
  if (rx.mode === 'photo' && !rx.transcription_confirmed_at) throw new AppError('TRANSCRIPTION_PENDING', 'Waiting for the doctor to confirm the transcription');
  return rx;
}

export async function getPrescriptionForViewer(ctx: Ctx, req: FastifyRequest, rxId: string) {
  const rx = await maybeOne(ctx.db, 'SELECT * FROM prescriptions WHERE id=$1', [rxId]);
  if (!rx) throw new AppError('NOT_FOUND', 'Prescription not found');
  if (!(req.auth.providerId && rx.prescriber_id === req.auth.providerId)) {
    await assertRecordAccess(ctx, req, rx.patient_id, 'prescription', rx.id);
  }
  if (rx.status === 'draft' && rx.prescriber_id !== req.auth.providerId) throw new AppError('NOT_FOUND', 'Prescription not found');
  return serializePrescription(ctx, rx);
}

export async function serializePrescription(ctx: Ctx, rx: any) {
  const items = await many(ctx.db, 'SELECT position, drug, strength, pattern, days, timing, sos, instructions FROM prescription_items WHERE prescription_id=$1 ORDER BY position', [rx.id]);
  const photos = await many(ctx.db, 'SELECT page_no, blob_key, pharmacist_transcribed_items, provider_confirmed_at FROM prescription_photos WHERE prescription_id=$1 ORDER BY page_no', [rx.id]);
  const alerts = await many(ctx.db, 'SELECT severity, message FROM clinical_alerts WHERE prescription_id=$1', [rx.id]);
  const doc = await one(ctx.db, 'SELECT u.name, p.reg_number, p.reg_type, p.qualifications FROM providers p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [rx.prescriber_id]);
  const successor = await maybeOne(ctx.db, 'SELECT id FROM prescriptions WHERE supersedes_id=$1', [rx.id]);
  return {
    id: rx.id,
    patient_id: rx.patient_id,
    version: rx.version,
    status: rx.status,
    mode: rx.mode,
    supersedes_id: rx.supersedes_id,
    superseded_by_id: successor?.id ?? null,
    signed_at: rx.signed_at,
    prescriber: { name: doc.name, reg_number: doc.reg_number, reg_type: doc.reg_type, qualifications: doc.qualifications },
    items,
    pages: await Promise.all(
      photos.map(async (p) => ({ page_no: p.page_no, url: await ctx.adapters.storage.presignGet(p.blob_key), transcribed_items: p.pharmacist_transcribed_items, confirmed: Boolean(p.provider_confirmed_at) })),
    ),
    alerts,
    transcription_confirmed: Boolean(rx.transcription_confirmed_at),
    pdf_available: Boolean(rx.pdf_key),
  };
}

// ───────────────────────────── Jobs ─────────────────────────────

/** Job: render the signed prescription PDF (name, registration number, signature line). */
export async function generatePrescriptionPdf(ctx: Ctx, rxId: string) {
  const rx = await maybeOne(ctx.db, 'SELECT * FROM prescriptions WHERE id=$1', [rxId]);
  if (!rx || rx.status === 'draft' || rx.pdf_key) return;
  const data = await serializePrescription(ctx, rx);
  const patient = await one(ctx.db, 'SELECT name, dob, sex FROM patients WHERE id=$1', [rx.patient_id]);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const text = (s: string, size = 11, f = font) => {
    page.drawText(ascii(s), { x: 48, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    y -= size + 7;
  };
  text('KM DocH - Doctor At Your Home', 16, bold);
  text(`Prescription v${rx.version}${rx.supersedes_id ? ' (correction - supersedes earlier version)' : ''}`, 10);
  y -= 6;
  text(`Dr. ${data.prescriber.name ?? ''}  ${data.prescriber.qualifications?.join(', ') ?? ''}`, 12, bold);
  text(`Registration: ${data.prescriber.reg_number} (${data.prescriber.reg_type})`, 10);
  text(`Patient: ${patient.name}${patient.sex ? ', ' + patient.sex : ''}`, 10);
  text(`Signed: ${formatIST(new Date(rx.signed_at))} IST`, 10);
  y -= 8;
  text('Rx', 14, bold);
  if (rx.mode === 'typed') {
    for (const it of data.items) {
      text(`${it.position}. ${it.drug} ${it.strength ?? ''}  ${it.pattern ?? ''}  ${it.days ? it.days + ' days' : ''} ${it.timing ?? ''} ${it.sos ? '(SOS)' : ''}`);
      if (it.instructions) text(`    ${it.instructions}`, 9);
    }
  } else {
    text(`Handwritten prescription: ${data.pages.length} page(s) attached to the record.`);
  }
  y = Math.min(y, 140);
  text('______________________________', 11);
  text(`Digitally signed by Dr. ${data.prescriber.name ?? ''} (${data.prescriber.reg_number})`, 9);
  text('KM DocH is a mediator. Diagnosis and prescription are the responsibility of the treating doctor.', 8);
  const bytes = Buffer.from(await pdf.save());
  const key = `prescriptions/${rx.patient_id}/${rx.id}.pdf`;
  await ctx.adapters.storage.put(key, bytes, 'application/pdf');
  await ctx.db.query('UPDATE prescriptions SET pdf_key=$2 WHERE id=$1 AND pdf_key IS NULL', [rxId, key]);
}

const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, '?'); // standard fonts are WinAnsi; production should embed a Unicode font

/** Job: image quality check + OCR for each photo page. Pharmacist transcription follows. */
export async function processPrescriptionOcr(ctx: Ctx, rxId: string) {
  const pages = await many(ctx.db, `SELECT pp.*, u.content_type FROM prescription_photos pp JOIN uploads u ON u.blob_key=pp.blob_key WHERE pp.prescription_id=$1 AND pp.quality_status='pending'`, [rxId]);
  for (const p of pages) {
    let img: Buffer;
    try {
      img = await ctx.adapters.storage.get(p.blob_key);
    } catch {
      await ctx.db.query(`UPDATE prescription_photos SET quality_status='rejected', quality_reason='missing_upload' WHERE id=$1`, [p.id]);
      continue;
    }
    const q = await ctx.adapters.ocr.checkQuality(img, p.content_type);
    if (!q.ok) {
      await ctx.db.query(`UPDATE prescription_photos SET quality_status='rejected', quality_reason=$2 WHERE id=$1`, [p.id, q.reason ?? 'quality']);
      continue;
    }
    const text = await ctx.adapters.ocr.extractText(img, p.content_type);
    await ctx.db.query(`UPDATE prescription_photos SET quality_status='ok', ocr_text_enc=$2 WHERE id=$1`, [p.id, text ? ctx.cipher.encrypt(text) : null]);
  }
}
