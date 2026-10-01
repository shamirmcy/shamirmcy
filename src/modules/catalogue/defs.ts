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
}

const line = (row: OptionRow, qty = 1): LineItem => ({
  option_code: row.code,
  name: row.name,
  unit_price_paise: row.price_paise,
  qty,
  amount_paise: row.price_paise * qty,
  payee_role: row.payee_role,
  payout_rule: row.payout_rule,
});

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
    return [line(opt('visit'), n), line(opt('materials'), n)];
  },
  slots: () => [lead('staff_nurse')],
  requiresPrescription: () => false,
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
  lines: (o, opt) => [line(opt(o.shift === 'day' ? 'shift_day' : 'shift_night'), DURATION_DAYS[o.duration])],
  slots: () => [lead('caregiver')],
  requiresPrescription: () => false,
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
