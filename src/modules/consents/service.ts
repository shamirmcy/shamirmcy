import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, type Queryable } from '../../lib/db.js';

export const REQUIRED_CONSENT_KEYS = ['responsibility', 'share_records', 'fee_acceptance'] as const;

/** Latest active version of each template that applies to the service. */
export async function currentTemplates(db: Queryable, serviceCode?: string) {
  return many(
    db,
    `SELECT DISTINCT ON (key) key, version, text, required, service_codes FROM consent_templates
     WHERE active AND ($1::text IS NULL OR service_codes IS NULL OR $1 = ANY(service_codes))
     ORDER BY key, version DESC`,
    [serviceCode ?? null],
  );
}

export interface ConsentInput {
  template_key: string;
  version: number;
}

/**
 * Records consents for a request and verifies every required template is granted at its current
 * version. Throws CONSENT_REQUIRED listing what is missing.
 */
export async function recordRequestConsents(
  c: Queryable,
  a: { patientId: string; userId: string; requestId: string; serviceCode: string; consents: ConsentInput[]; ip: string; device: string | null },
) {
  const templates = await currentTemplates(c, a.serviceCode);
  const current = new Map(templates.map((t) => [t.key as string, t]));
  const granted = new Map<string, number>();
  for (const cin of a.consents) {
    const t = current.get(cin.template_key);
    if (t && t.version === cin.version) granted.set(cin.template_key, cin.version);
  }
  const requiredKeys = new Set<string>([...REQUIRED_CONSENT_KEYS, ...templates.filter((t) => t.required).map((t) => t.key as string)]);
  const missing = [...requiredKeys].filter((k) => !granted.has(k));
  if (missing.length) {
    throw new AppError('CONSENT_REQUIRED', 'Required consents are missing or out of date', {
      missing: missing.map((k) => ({ template_key: k, current_version: current.get(k)?.version ?? null })),
    });
  }
  for (const [key, version] of granted) {
    await c.query(
      `INSERT INTO consents (patient_id, granted_by_user_id, request_id, template_key, version, device, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.patientId, a.userId, a.requestId, key, version, a.device, a.ip],
    );
  }
}

export async function hasRequiredConsents(c: Queryable, requestId: string, serviceCode: string): Promise<boolean> {
  const templates = await currentTemplates(c, serviceCode);
  const required = new Set<string>([...REQUIRED_CONSENT_KEYS, ...templates.filter((t) => t.required).map((t) => t.key as string)]);
  const rows = await many(c, 'SELECT template_key FROM consents WHERE request_id=$1 AND withdrawn_at IS NULL', [requestId]);
  const have = new Set(rows.map((r) => r.template_key as string));
  return [...required].every((k) => have.has(k));
}

export async function listConsents(ctx: Ctx, userId: string) {
  return many(
    ctx.db,
    `SELECT c.id, c.patient_id, p.name AS patient_name, c.request_id, c.template_key, c.version, c.granted_at, c.withdrawn_at
     FROM consents c JOIN patients p ON p.id=c.patient_id
     JOIN family_links fl ON fl.patient_id=c.patient_id AND fl.account_holder_id=$1 AND fl.deleted_at IS NULL
     ORDER BY c.granted_at DESC LIMIT 500`,
    [userId],
  );
}
