import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { PayoutRule } from '../../lib/money.js';
import type { ProviderRole } from '../providers/roles.js';

/**
 * Service structure lives in code; every price and payout rule lives in `service_options`
 * so ops can change them without a deploy. The client never sends a price.
 */

export interface OptionRow {
  code: string;
  name: string;
  price_paise: number;
  unit: string;
  payee_role: ProviderRole | null;
  payout_rule: PayoutRule;
  meta: Record<string, unknown>;
  active: boolean;
}

export interface LineItem {
  option_code: string;
  name: string;
  unit_price_paise: number;
  qty: number;
  amount_paise: number;
  payee_role: ProviderRole | null;
  payout_rule: PayoutRule;
  /** Billed and paid out per completed visit (series services). */
  per_visit?: boolean;
  /** Quoted price is an estimate ("up to" / "about"); the actual cost is recorded at the visit and never exceeds it. */
  estimate?: boolean;
}

export interface SlotSpec {
  role: ProviderRole;
  role_in_visit: 'lead' | 'assist' | 'remote_supervisor';
  remote: boolean;
}

export interface ServiceDef<O = any> {
  code: string;
  kind: 'service_request' | 'equipment_rental';
  optionsSchema: z.ZodType<O>;
  lines(o: O, opt: (code: string) => OptionRow): LineItem[];
  slots(o: O): SlotSpec[];
  requiresPrescription(o: O): boolean;
  firstDoseMode?(o: O): 'with_doctor' | 'safe_team' | 'at_hospital' | null;
  /** Visit schedule. Default: one visit at `firstAt` (null = as soon as possible). */
  schedule?(o: O, firstAt: Date | null, now: Date): Array<Date | null>;
  /** How long one visit blocks the professional's calendar. Default 90 minutes. */
  visitMinutes?(o: O): number;
}

const line = (row: OptionRow, qty = 1, perVisit = false): LineItem => ({
  option_code: row.code,
  name: row.name,
  unit_price_paise: row.price_paise,
  qty,
  amount_paise: row.price_paise * qty,
  payee_role: row.payee_role,
  payout_rule: row.payout_rule,
  ...(perVisit ? { per_visit: true } : {}),
  ...(row.meta?.estimate ? { estimate: true } : {}),
});

const DAY_MS = 86_400_000;

/** A wall-clock time in IST on a YYYY-MM-DD date, as a UTC instant. */
export function istAt(date: string, hh: number, mm = 0): Date {
  return new Date(Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`));
}

export function scheduleFor(def: ServiceDef, o: unknown, firstAt: Date | null, now = new Date()): Array<Date | null> {
  return def.schedule ? def.schedule(o, firstAt, now) : [firstAt];
}

export const visitMinutesFor = (def: ServiceDef, o: unknown) => def.visitMinutes?.(o) ?? 90;

const lead = (role: ProviderRole): SlotSpec => ({ role, role_in_visit: 'lead', remote: false });
const assist = (role: ProviderRole): SlotSpec => ({ role, role_in_visit: 'assist', remote: false });

export const NURSE_REASONS = ['vitals', 'injection', 'post_op', 'elder_checkup', 'catheter_care'] as const;
export const SPECIALTIES = [
  'cardiology',
  'endocrinology',
  'neurology',
  'psychiatry',
  'pulmonology',
  'orthopaedics',
  'dermatology',
  'paediatrics',
  'geriatrics',
  'nephrology',
  'oncology',
  'gynaecology',
] as const;
export const LAB_TESTS = ['sugar_fpp', 'cbc', 'tsh', 'hba1c', 'lipid', 'kft', 'lft', 'ecg'] as const;
const BLOOD_TESTS = new Set<string>(LAB_TESTS.filter((t) => t !== "ecg"));

const FREQUENCY_VISITS = { single: 1, daily_x5: 5, alternate_x7: 7 } as const;
const DURATION_DAYS = { day: 1, week: 7, month: 30 } as const;

const doctorVisit: ServiceDef<Record<string, never>> = {
  code: 'doctor_visit',
  kind: 'service_request',
  optionsSchema: z.object({}).strict(),
  lines: (_o, opt) => [line(opt('visit'))],
  slots: () => [lead('doctor')],
  requiresPrescription: () => false,
};

const nurseVisitOptions = z.object({ reason: z.enum(NURSE_REASONS) }).strict();
const nurseVisit: ServiceDef<z.infer<typeof nurseVisitOptions>> = {
  code: 'nurse_visit',
  kind: 'service_request',
  optionsSchema: nurseVisitOptions,
  lines: (_o, opt) => [line(opt('visit'))],
  slots: () => [lead('staff_nurse')],
  // Nurses give injections only as prescribed.
  requiresPrescription: (o) => o.reason === 'injection',
};

const specialistOptions = z.object({ specialty: z.enum(SPECIALTIES), video_slot: z.string().datetime() }).strict();
const specialistVisit: ServiceDef<z.infer<typeof specialistOptions>> = {
  code: 'specialist_visit',
  kind: 'service_request',
  optionsSchema: specialistOptions,
  lines: (_o, opt) => [line(opt('nurse_component')), line(opt('consultant_fee'))],
  // Consultant leads remotely over video; the nurse is at home taking vitals.
  slots: () => [{ role: 'consultant', role_in_visit: 'lead', remote: true }, assist('staff_nurse')],
  visitMinutes: () => 60,
  requiresPrescription: () => false,
};

const ivOptions = z
  .object({ iv_type: z.enum(['drip', 'antibiotic']), first_dose_mode: z.enum(['with_doctor', 'safe_team', 'at_hospital']) })
  .strict();
const ivCare: ServiceDef<z.infer<typeof ivOptions>> = {
  code: 'iv_care',
  kind: 'service_request',
  optionsSchema: ivOptions,
  lines: (o, opt) => {
    const kit = line(opt(o.iv_type === 'drip' ? 'kit_drip' : 'kit_antibiotic'));
    switch (o.first_dose_mode) {
      case 'with_doctor':
        return [line(opt('visit')), line(opt('first_dose_doctor')), kit];
      case 'safe_team':
        return [line(opt('first_dose_team_cct')), line(opt('first_dose_team_nurse')), kit];
      case 'at_hospital':
        return [line(opt('visit')), kit];
    }
  },
  slots: (o) => {
    switch (o.first_dose_mode) {
      // The doctor's slot becomes `remote_supervisor` if they choose remote monitoring on accept.
      case 'with_doctor':
        return [lead('doctor'), assist('staff_nurse')];
      case 'safe_team':
        return [lead('critical_care_technician'), assist('staff_nurse')];
      case 'at_hospital':
        return [lead('staff_nurse')];
    }
  },
  requiresPrescription: () => true,
  firstDoseMode: (o) => o.first_dose_mode,
};

const dressingOptions = z
  .object({ wound_type: z.enum(['surgical', 'diabetic_ulcer', 'pressure_sore', 'burn', 'trauma', 'other']), frequency: z.enum(['single', 'daily_x5', 'alternate_x7']) })
  .strict();
const woundDressing: ServiceDef<z.infer<typeof dressingOptions>> = {
  code: 'wound_dressing',
  kind: 'service_request',
  optionsSchema: dressingOptions,
  lines: (o, opt) => {
    const n = FREQUENCY_VISITS[o.frequency];
    return [line(opt('visit'), n, true), line(opt('materials'), n, true)];
  },
  slots: () => [lead('staff_nurse')],
  requiresPrescription: () => false,
  // Daily ×5 or alternate days ×7, same nurse, from the first visit.
  schedule: (o, firstAt, now) => {
    const n = FREQUENCY_VISITS[o.frequency];
    const gap = o.frequency === 'alternate_x7' ? 2 : 1;
    const base = firstAt ?? now;
    return Array.from({ length: n }, (_, i) => (i === 0 ? firstAt : new Date(base.getTime() + i * gap * DAY_MS)));
  },
};

const catheterisation: ServiceDef<Record<string, never>> = {
  code: 'catheterisation',
  kind: 'service_request',
  optionsSchema: z.object({}).strict(),
  lines: (_o, opt) => [line(opt('visit'))],
  slots: () => [lead('staff_nurse')],
  requiresPrescription: () => false,
};

const elderOptions = z
  .object({ shift: z.enum(['day', 'night']), duration: z.enum(['day', 'week', 'month']), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();
const elderCare: ServiceDef<z.infer<typeof elderOptions>> = {
  code: 'elder_care',
  kind: 'service_request',
  optionsSchema: elderOptions,
  lines: (o, opt) => [line(opt(o.shift === 'day' ? 'shift_day' : 'shift_night'), DURATION_DAYS[o.duration], true)],
  slots: () => [lead('caregiver')],
  requiresPrescription: () => false,
  visitMinutes: (o) => (o.shift === 'day' ? 7 * 60 : 10 * 60),
  // One shift per day from start_date: day 10 am–5 pm, night 9 pm–7 am (IST).
  schedule: (o) => {
    const first = o.shift === 'day' ? istAt(o.start_date, 10) : istAt(o.start_date, 21);
    return Array.from({ length: DURATION_DAYS[o.duration] }, (_, i) => new Date(first.getTime() + i * DAY_MS));
  },
};

const labOptions = z.object({ tests: z.array(z.enum(LAB_TESTS)).min(1).max(LAB_TESTS.length), fasting: z.boolean().default(false) }).strict();
const labTests: ServiceDef<z.infer<typeof labOptions>> = {
  code: 'lab_tests',
  kind: 'service_request',
  optionsSchema: labOptions,
  lines: (o, opt) => {
    const tests = [...new Set(o.tests)];
    const out = tests.some((t) => BLOOD_TESTS.has(t)) ? [line(opt('collection'))] : [];
    return out.concat(tests.map((t) => line(opt(`test_${t}`))));
  },
  slots: () => [lead('lab_technician')],
  requiresPrescription: () => false,
};

const equipmentOptions = z
  .object({ item: z.enum(['patient_monitor', 'o2_concentrator']), rate_type: z.enum(['day', 'month']), quantity: z.number().int().min(1).max(12) })
  .strict();
const equipmentRental: ServiceDef<z.infer<typeof equipmentOptions>> = {
  code: 'equipment_rental',
  kind: 'equipment_rental',
  optionsSchema: equipmentOptions,
  lines: (o, opt) => [line(opt(`${o.item}_${o.rate_type}`), o.quantity)],
  slots: () => [],
  requiresPrescription: () => false,
};

const alsEmergency: ServiceDef<Record<string, never>> = {
  code: 'als_emergency',
  kind: 'service_request',
  optionsSchema: z.object({}).strict(),
  lines: (_o, opt) => [line(opt('team'))],
  slots: () => [lead('critical_care_technician')],
  requiresPrescription: () => false,
};

export const SERVICE_DEFS: Record<string, ServiceDef> = Object.fromEntries(
  [doctorVisit, nurseVisit, specialistVisit, ivCare, woundDressing, catheterisation, elderCare, labTests, equipmentRental, alsEmergency].map((d) => [d.code, d]),
);

export function getDef(code: string): ServiceDef {
  const d = SERVICE_DEFS[code];
  if (!d) throw new AppError('NOT_FOUND', `Unknown service ${code}`);
  return d;
}
