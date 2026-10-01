import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Reference data: catalogue + prices, consent templates, practice terms, responsibility content,
 * clinical rules and a starter medicine list. Idempotent — safe to re-run; it never overwrites
 * prices that ops has since edited (ON CONFLICT DO NOTHING).
 */

type Rule = { type: 'percent_fee'; fee_bps: number } | { type: 'full' } | { type: 'none' };
const pct = (bps = 2000): Rule => ({ type: 'percent_fee', fee_bps: bps });
const FULL: Rule = { type: 'full' };
const NONE: Rule = { type: 'none' };

interface Opt {
  code: string;
  name: string;
  price: number; // paise
  unit?: string;
  payee: string | null;
  rule: Rule;
  meta?: Record<string, unknown>;
}

const SERVICES: Array<{ code: string; name: string; category: string; window?: number; emergency?: boolean; live_map?: boolean; description: string; options: Opt[] }> = [
  {
    code: 'doctor_visit',
    name: 'Doctor home visit',
    category: 'visit',
    window: 120,
    description: 'A licensed doctor visits you at home within 2 hours.',
    options: [{ code: 'visit', name: 'Doctor home visit', price: 89900, payee: 'doctor', rule: pct() }],
  },
  {
    code: 'nurse_visit',
    name: 'Nurse visit',
    category: 'visit',
    window: 120,
    description: 'Vitals, injections (as prescribed), post-op care, elder check-up, catheter care.',
    options: [{ code: 'visit', name: 'Nurse visit', price: 39900, payee: 'staff_nurse', rule: pct() }],
  },
  {
    code: 'specialist_visit',
    name: 'Specialist at home',
    category: 'visit',
    window: 180,
    description: 'A nurse at home with a specialist on video.',
    options: [
      { code: 'nurse_component', name: 'Nurse at home', price: 39900, payee: 'staff_nurse', rule: pct() },
      { code: 'consultant_fee', name: 'Specialist video consult', price: 110000, payee: 'consultant', rule: pct() },
    ],
  },
  {
    code: 'iv_care',
    name: 'IV care at home',
    category: 'visit',
    window: 180,
    description: 'Drip or IV antibiotics at home. Prescription required. Choose how the first dose is supervised.',
    options: [
      { code: 'visit', name: 'Nurse visit', price: 39900, payee: 'staff_nurse', rule: pct() },
      { code: 'kit_drip', name: 'Drip kit (up to)', price: 60000, payee: null, rule: NONE },
      { code: 'kit_antibiotic', name: 'Antibiotic IV kit (approx.)', price: 25000, payee: null, rule: NONE },
      { code: 'first_dose_doctor', name: 'First dose with your doctor (present or on video)', price: 59900, payee: 'doctor', rule: pct() },
      // ₹999 safe first-dose team, split technician ₹600 + nurse ₹399 (ASSUMPTION — confirm with business).
      { code: 'first_dose_team_cct', name: 'Safe first-dose team — critical care technician', price: 60000, payee: 'critical_care_technician', rule: pct() },
      { code: 'first_dose_team_nurse', name: 'Safe first-dose team — staff nurse', price: 39900, payee: 'staff_nurse', rule: pct() },
    ],
  },
  {
    code: 'wound_dressing',
    name: 'Wound dressing',
    category: 'visit',
    window: 180,
    description: 'Per visit. Single, daily for 5 days, or alternate days for 7 visits.',
    options: [
      { code: 'visit', name: 'Dressing visit', price: 39900, unit: 'visit', payee: 'staff_nurse', rule: FULL },
      { code: 'materials', name: 'Dressing materials (approx.)', price: 12000, unit: 'visit', payee: null, rule: NONE },
    ],
  },
  {
    code: 'catheterisation',
    name: 'Bladder catheterisation',
    category: 'visit',
    window: 180,
    description: 'Kit included.',
    options: [{ code: 'visit', name: 'Catheterisation (kit included)', price: 99900, payee: 'staff_nurse', rule: pct() }],
  },
  {
    code: 'elder_care',
    name: 'Elder care',
    category: 'visit',
    description: 'Day 10 am–5 pm or night 9 pm–7 am. 1 day, 1 week or 1 month.',
    options: [
      { code: 'shift_day', name: 'Day shift (10 am–5 pm)', price: 59900, unit: 'shift', payee: 'caregiver', rule: pct() },
      { code: 'shift_night', name: 'Night shift (9 pm–7 am)', price: 69900, unit: 'shift', payee: 'caregiver', rule: pct() },
    ],
  },
  {
    code: 'lab_tests',
    name: 'Tests at home',
    category: 'lab',
    window: 240,
    description: 'Home sample collection and ECG.',
    options: [
      { code: 'collection', name: 'Home collection', price: 10000, payee: 'lab_technician', rule: pct(3000) },
      { code: 'test_sugar_fpp', name: 'Blood sugar (fasting / PP)', price: 8000, payee: null, rule: NONE, meta: { fasting: true } },
      { code: 'test_cbc', name: 'Complete blood count', price: 35000, payee: null, rule: NONE },
      { code: 'test_tsh', name: 'TSH', price: 40000, payee: null, rule: NONE },
      { code: 'test_hba1c', name: 'HbA1c', price: 55000, payee: null, rule: NONE },
      { code: 'test_lipid', name: 'Lipid profile', price: 60000, payee: null, rule: NONE, meta: { fasting: true } },
      { code: 'test_kft', name: 'Kidney function', price: 70000, payee: null, rule: NONE },
      { code: 'test_lft', name: 'Liver function', price: 80000, payee: null, rule: NONE },
      { code: 'test_ecg', name: 'ECG at home', price: 49900, payee: 'lab_technician', rule: pct() },
    ],
  },
  {
    code: 'equipment_rental',
    name: 'Equipment rental',
    category: 'equipment',
    description: 'The supplier handles repairs and damage.',
    options: [
      { code: 'patient_monitor_day', name: 'Patient monitor (per day)', price: 80000, unit: 'day', payee: null, rule: NONE },
      { code: 'patient_monitor_month', name: 'Patient monitor (per month)', price: 800000, unit: 'month', payee: null, rule: NONE },
      { code: 'o2_concentrator_day', name: 'Oxygen concentrator (per day)', price: 50000, unit: 'day', payee: null, rule: NONE },
      { code: 'o2_concentrator_month', name: 'Oxygen concentrator (per month)', price: 500000, unit: 'month', payee: null, rule: NONE },
    ],
  },
  {
    code: 'ambulance',
    name: 'Ambulance',
    category: 'ambulance',
    emergency: true,
    live_map: true,
    description: 'Licensed partner ambulances. 108 is always available.',
    // OPEN ITEM: per-km rates are placeholders until the business confirms them.
    options: [
      { code: 'per_km_normal', name: 'Ambulance (per km)', price: 3000, unit: 'km', payee: null, rule: NONE, meta: { placeholder: true } },
      { code: 'per_km_oxygen', name: 'Oxygen ambulance (per km)', price: 4500, unit: 'km', payee: null, rule: NONE, meta: { placeholder: true } },
      { code: 'per_km_ventilator', name: 'Ventilator ambulance (per km)', price: 7000, unit: 'km', payee: null, rule: NONE, meta: { placeholder: true } },
    ],
  },
  {
    code: 'als_emergency',
    name: 'ALS emergency team',
    category: 'emergency',
    window: 30,
    emergency: true,
    description: 'CPR, defibrillation and airway support by a critical care technician.',
    options: [{ code: 'team', name: 'ALS emergency team', price: 199900, payee: 'critical_care_technician', rule: pct() }],
  },
  {
    code: 'medicines',
    name: 'Medicines',
    category: 'medicine',
    live_map: true,
    description: 'Delivered at MRP / list price.',
    options: [],
  },
];

const CONSENTS = [
  {
    key: 'responsibility',
    required: true,
    text: {
      en: 'I understand KM DocH is a mediator. Diagnosis and prescription are the responsibility of the treating doctor.',
      ta: 'KM DocH ஒரு இடைத்தரகர் என்பதை நான் புரிந்துகொள்கிறேன். நோயறிதலும் மருந்துச்சீட்டும் சிகிச்சையளிக்கும் மருத்துவரின் பொறுப்பு.',
      kn: 'KM DocH ಮಧ್ಯವರ್ತಿ ಎಂದು ನನಗೆ ತಿಳಿದಿದೆ. ರೋಗನಿರ್ಣಯ ಮತ್ತು ಪ್ರಿಸ್ಕ್ರಿಪ್ಷನ್ ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರ ಜವಾಬ್ದಾರಿ.',
      hi: 'मैं समझता/समझती हूँ कि KM DocH एक मध्यस्थ है। निदान और पर्चा इलाज करने वाले डॉक्टर की ज़िम्मेदारी है।',
    },
  },
  {
    key: 'share_records',
    required: true,
    text: {
      en: 'Share my health records with the assigned care professional for this visit.',
      ta: 'இந்த வருகைக்கு ஒதுக்கப்பட்ட பராமரிப்பாளருடன் என் சுகாதாரப் பதிவுகளைப் பகிரவும்.',
      kn: 'ಈ ಭೇಟಿಗೆ ನಿಯೋಜಿಸಲಾದ ಆರೈಕೆ ವೃತ್ತಿಪರರೊಂದಿಗೆ ನನ್ನ ಆರೋಗ್ಯ ದಾಖಲೆಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳಿ.',
      hi: 'इस विज़िट के लिए नियुक्त देखभाल विशेषज्ञ के साथ मेरे स्वास्थ्य रिकॉर्ड साझा करें।',
    },
  },
  {
    key: 'fee_acceptance',
    required: true,
    text: {
      en: 'I accept the quoted total for this service.',
      ta: 'இந்த சேவைக்கான குறிப்பிட்ட மொத்தத் தொகையை ஏற்கிறேன்.',
      kn: 'ಈ ಸೇವೆಗೆ ತಿಳಿಸಿದ ಒಟ್ಟು ಮೊತ್ತವನ್ನು ನಾನು ಒಪ್ಪುತ್ತೇನೆ.',
      hi: 'मैं इस सेवा के लिए बताई गई कुल राशि स्वीकार करता/करती हूँ।',
    },
  },
  {
    key: 'family_present',
    required: false,
    text: {
      en: 'A family member will be present during the visit.',
      ta: 'வருகையின் போது குடும்ப உறுப்பினர் இருப்பார்.',
      kn: 'ಭೇಟಿಯ ಸಮಯದಲ್ಲಿ ಕುಟುಂಬದ ಸದಸ್ಯರು ಇರುತ್ತಾರೆ.',
      hi: 'विज़िट के दौरान परिवार का एक सदस्य मौजूद रहेगा।',
    },
  },
];

const COMMON_TERMS = [
  { title: 'Mediator model', text: 'KM DocH connects you with patients and publishes fixed prices. Clinical decisions are yours and the patient’s.' },
  { title: 'Location', text: 'Your location is collected only while you are on duty and only to estimate arrival time. Patients never see your location.' },
  { title: 'Door code', text: 'Enter the patient’s 4-digit visit code when you arrive. Never start a visit without it.' },
  { title: 'Safety', text: 'Family may accompany the patient during the visit. Report any safety concern to the partner desk.' },
];

const TERMS: Record<string, Array<{ title: string; text: string }>> = {
  doctor: [
    ...COMMON_TERMS,
    { title: 'Prescriptions', text: 'You are responsible for diagnosis and prescriptions. Signed prescriptions cannot be edited; issue a correction instead.' },
    { title: 'First dose', text: 'For first doses you are present or monitoring remotely on video, together with the nurse.' },
  ],
  consultant: [...COMMON_TERMS, { title: 'Video consults', text: 'Follow the Telemedicine Practice Guidelines 2020. Psychiatry notes are visible to you only.' }],
  staff_nurse: [...COMMON_TERMS, { title: 'Injections', text: 'Give injections and IV medicines only as prescribed. Check the prescription before every dose.' }],
  critical_care_technician: [...COMMON_TERMS, { title: 'Doctor’s plan', text: 'Work to the doctor’s plan. Carry the emergency drug kit on first-dose and ALS calls.' }],
  lab_technician: [...COMMON_TERMS, { title: 'Samples', text: 'Label samples at the bedside and maintain the cold chain.' }],
  caregiver: [...COMMON_TERMS, { title: 'Scope', text: 'Caregivers do not give medicines or injections. Call the partner desk for any clinical concern.' }],
};

const PATIENT_ABOUT = {
  title: 'About KM DocH',
  mediator: 'KM DocH is a mediator. We connect you with licensed doctors, nurses, technicians, caregivers, labs, equipment suppliers and ambulance partners, and publish a fixed price for every service.',
  responsibilities: [
    { topic: 'Diagnosis and prescription', responsible: 'Your doctor' },
    { topic: 'First-dose safety', responsible: 'You choose: hospital, your doctor + nurse, or the KM DocH team' },
    { topic: 'Equipment repair and damage', responsible: 'The supplier' },
    { topic: 'Ambulance', responsible: 'Licensed partner operators' },
  ],
  emergency: 'In a life-threatening emergency you can always call 108.',
};

const PROVIDER_RESPONSIBILITIES = {
  items: [
    { topic: 'First dose and reactions', text: 'Doctor + nurse together. The doctor is present or monitoring remotely (₹599 + ₹399), or the KM DocH critical care technician + staff nurse handle it.' },
    { topic: 'Medicines and referral queries', text: 'KM DocH partner desk.' },
    { topic: 'Safety on visits', text: 'Family may accompany; KM DocH is a mediator.' },
  ],
};

const CLINICAL_RULES = [
  { kind: 'drug_condition', drug: '(cillin|mycin|floxacin|cef|cycline|azithro|metronidazole)', match: 'diabetes', severity: 'warning', message: 'Patient has diabetes (likely on metformin): advise good hydration and closer sugar monitoring during the antibiotic course.' },
  { kind: 'drug_drug', drug: '(cillin|mycin|floxacin|cef|cycline|azithro|metronidazole)', match: 'metformin', severity: 'warning', message: 'Patient is on metformin: advise hydration and sugar monitoring during the antibiotic course.' },
  { kind: 'drug_condition', drug: '(ibuprofen|diclofenac|naproxen|aceclofenac|ketorolac)', match: 'kidney', severity: 'critical', message: 'NSAID with kidney disease: avoid or use the lowest dose with renal monitoring.' },
  { kind: 'drug_condition', drug: '(ibuprofen|diclofenac|naproxen|aceclofenac)', match: 'ulcer', severity: 'warning', message: 'NSAID with peptic ulcer history: consider gastro-protection or an alternative.' },
  { kind: 'drug_allergy', drug: '(amoxi|ampi|penicillin|piperacillin|cloxa)', match: 'penicillin', severity: 'critical', message: 'Penicillin allergy recorded: this drug is a penicillin.' },
  { kind: 'drug_allergy', drug: '(sulfa|cotrimoxazole|sulfamethoxazole)', match: 'sulfa', severity: 'critical', message: 'Sulfa allergy recorded.' },
  { kind: 'drug_drug', drug: '(clarithromycin|erythromycin)', match: '(atorvastatin|simvastatin)', severity: 'warning', message: 'Macrolide with statin: risk of myopathy; consider holding the statin.' },
  { kind: 'drug_drug', drug: '(warfarin|acenocoumarol)', match: '(aspirin|clopidogrel|ibuprofen|diclofenac)', severity: 'critical', message: 'Anticoagulant with antiplatelet/NSAID: bleeding risk.' },
];

const MEDICINES = [
  ['PCM500', 'Paracetamol', '500 mg', 'tablet', 'OTC', 200],
  ['ORS', 'Oral rehydration salts', '21 g', 'sachet', 'OTC', 2200],
  ['MET500', 'Metformin', '500 mg', 'tablet', 'H', 350],
  ['AMOX500', 'Amoxicillin', '500 mg', 'capsule', 'H', 1100],
  ['AZI500', 'Azithromycin', '500 mg', 'tablet', 'H', 2400],
  ['CEFTRI1G', 'Ceftriaxone', '1 g', 'injection', 'H', 6500],
  ['PAN40', 'Pantoprazole', '40 mg', 'tablet', 'H', 900],
  ['NS500', 'Normal saline', '500 ml', 'iv_fluid', 'H', 3500],
  ['CETZ10', 'Cetirizine', '10 mg', 'tablet', 'OTC', 250],
] as const;

export async function seedReference(db: pg.Pool | pg.Client) {
  for (const [i, s] of SERVICES.entries()) {
    const r = await db.query(
      `INSERT INTO services (code, name, category, description, promised_window_minutes, emergency, live_map_allowed, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO UPDATE SET code=EXCLUDED.code RETURNING id`,
      [s.code, s.name, s.category, s.description, s.window ?? null, Boolean(s.emergency), Boolean(s.live_map), i],
    );
    const sid = r.rows[0].id;
    for (const o of s.options) {
      await db.query(
        `INSERT INTO service_options (service_id, code, name, price_paise, unit, payee_role, payout_rule, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (service_id, code) DO NOTHING`,
        [sid, o.code, o.name, o.price, o.unit ?? 'each', o.payee, JSON.stringify(o.rule), JSON.stringify(o.meta ?? {})],
      );
    }
  }
  for (const c of CONSENTS) {
    await db.query(`INSERT INTO consent_templates (key, version, text, required) VALUES ($1,1,$2,$3) ON CONFLICT (key, version) DO NOTHING`, [c.key, c.text, c.required]);
  }
  for (const [role, items] of Object.entries(TERMS)) {
    await db.query(`INSERT INTO provider_terms (role, version, items) VALUES ($1,1,$2) ON CONFLICT (role, version) DO NOTHING`, [role, JSON.stringify(items)]);
  }
  await db.query(`INSERT INTO content_blocks (key, audience, content) VALUES ('patient_about','patient',$1) ON CONFLICT (key) DO NOTHING`, [PATIENT_ABOUT]);
  await db.query(`INSERT INTO content_blocks (key, audience, content) VALUES ('provider_responsibilities','provider',$1) ON CONFLICT (key) DO NOTHING`, [PROVIDER_RESPONSIBILITIES]);
  const existingRules = await db.query('SELECT count(*)::int AS n FROM clinical_rules');
  if (existingRules.rows[0].n === 0) {
    for (const r of CLINICAL_RULES) {
      await db.query('INSERT INTO clinical_rules (kind, drug_pattern, match_value, severity, message) VALUES ($1,$2,$3,$4,$5)', [r.kind, r.drug, r.match, r.severity, r.message]);
    }
  }
  for (const m of MEDICINES) {
    await db.query('INSERT INTO medicines (sku, name, strength, form, schedule, mrp_paise) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sku) DO NOTHING', m as unknown as unknown[]);
  }
  await db.query(`INSERT INTO app_config (key, value) VALUES ('cancellation_fee_after_confirmed_paise', '0') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO app_config (key, value) VALUES ('triage_services', '[]') ON CONFLICT DO NOTHING`);
}

/** Demo zones (OPEN ITEM: launch city and pincodes to be confirmed). */
export async function seedDemoZones(db: pg.Pool | pg.Client) {
  await db.query(
    `INSERT INTO service_zones (name, city, pincodes, area)
     SELECT 'Indiranagar', 'Bengaluru', ARRAY['560038','560008','560071'],
            ST_Multi(ST_MakeEnvelope(77.62, 12.95, 77.67, 12.99, 4326))::geography
     WHERE NOT EXISTS (SELECT 1 FROM service_zones WHERE name='Indiranagar')`,
  );
  await db.query(
    `INSERT INTO service_zones (name, city, pincodes, area)
     SELECT 'Kumbakonam Town', 'Kumbakonam', ARRAY['612001','612002'],
            ST_Multi(ST_MakeEnvelope(79.35, 10.93, 79.41, 10.99, 4326))::geography
     WHERE NOT EXISTS (SELECT 1 FROM service_zones WHERE name='Kumbakonam Town')`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const client = new pg.Client({ connectionString: loadConfig().env.DATABASE_URL });
  await client.connect();
  await seedReference(client);
  if (process.argv.includes('--demo')) await seedDemoZones(client);
  await client.end();
  console.log('seed complete');
}
