import { maybeOne, type Queryable } from '../../lib/db.js';

const ROLE_TITLE: Record<string, string> = {
  doctor: 'General physician',
  consultant: 'Consultant',
  staff_nurse: 'Staff nurse',
  critical_care_technician: 'Critical care technician',
  lab_technician: 'Lab technician',
  caregiver: 'Caregiver',
};

/** "MBBS · General physician · 11 yrs" */
export function providerCredentials(p: { role: string; qualifications?: string[]; specialities?: string[]; years_experience?: number | null }) {
  const parts = [
    (p.qualifications ?? []).join(', ') || null,
    p.specialities?.[0] ? capitalise(p.specialities[0]) : ROLE_TITLE[p.role] ?? p.role,
    p.years_experience ? `${p.years_experience} yrs` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Latest moderated (approved) bio; pending edits are never shown to patients. */
export async function approvedBio(db: Queryable, providerId: string): Promise<string | null> {
  const b = await maybeOne(
    db,
    `SELECT text FROM provider_bios WHERE provider_id=$1 AND moderation_status='approved' ORDER BY created_at DESC LIMIT 1`,
    [providerId],
  );
  return b?.text ?? null;
}
