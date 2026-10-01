export const PROVIDER_ROLES = ['doctor', 'staff_nurse', 'critical_care_technician', 'lab_technician', 'caregiver', 'consultant'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export const REG_TYPE_BY_ROLE: Record<ProviderRole, string> = {
  doctor: 'medical_council',
  consultant: 'medical_council',
  staff_nurse: 'nursing_council',
  critical_care_technician: 'paramedical',
  lab_technician: 'paramedical',
  caregiver: 'training_certificate',
};

/** Roles that may author prescriptions. */
export const PRESCRIBER_ROLES: ProviderRole[] = ['doctor', 'consultant'];

/** Roles that work remotely (video) and therefore never need location collection. */
export const REMOTE_ROLES: ProviderRole[] = ['consultant'];
