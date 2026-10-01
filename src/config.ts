import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://kmdoch:kmdoch@localhost:5432/kmdoch'),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),
  // Secrets. Production refuses to boot with the dev defaults (see assertProductionSafe).
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-0123456789'),
  QUOTE_SECRET: z.string().min(32).default('dev-only-quote-secret-change-me-012345678'),
  OTP_PEPPER: z.string().min(16).default('dev-only-otp-pepper-change-me'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .default(Buffer.alloc(32, 7).toString('base64')), // 32 bytes base64; dev only
  PAYMENT_WEBHOOK_SECRET: z.string().default('dev-only-webhook-secret'),
  // Adapters
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['console', 'meta', 'off']).default('console'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_OTP_TEMPLATE: z.string().default('kmdoch_otp'),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  DEV_TOOLS: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  PAYMENT_GATEWAY: z.enum(['fake', 'razorpay']).default('fake'),
  // offline = straight-line ETA + sample address search; google = Routes API + Places/Geocoding.
  MAPS_PROVIDER: z.enum(['offline', 'google']).default('offline'),
  MAPS_TRAVEL_MODE: z.enum(['DRIVE', 'TWO_WHEELER']).default('DRIVE'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.local-storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().optional(),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  // Business
  PARTNER_DESK_PHONE: z.string().default('+910000000000'), // OPEN ITEM: placeholder until the business provides it
  OPS_ADMIN_PHONES: z.string().default(''),
  INLINE_JOBS: bool, // tests / single-process dev: run jobs in-process without BullMQ
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env;
  auth: {
    accessTtlSeconds: number;
    refreshTtlDays: number;
    otpLength: number;
    otpTtlSeconds: number;
    otpMaxAttempts: number;
    otpMaxSendsPerWindow: number;
    otpWindowSeconds: number;
  };
  quoteTtlSeconds: number;
  assignment: {
    offerTtlSeconds: number;
    offerFanout: number;
    maxCandidates: number;
    defaultWindowMinutes: number;
    straightLineFactor: number;
    avgSpeedKmh: number;
    weights: { language: number; continuity: number; rating: number; load: number; eta: number };
    etaCacheSeconds: number;
  };
  duty: { idleTimeoutSeconds: number; locationTtlSeconds: number };
  visitCodeMaxAttempts: number;
  ambulance: { ackTimeoutSeconds: number; emergencyNumber: string };
  pingRetentionDays: number;
  rateLimit: { authedPerMinute: number; publicPerMinute: number };
  defaultPlatformFeeBps: number;
  timezone: 'Asia/Kolkata';
}

export function loadConfig(overrides: Partial<Record<keyof Env, string>> = {}): AppConfig {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  if (env.NODE_ENV === 'production') assertProductionSafe(env);
  return {
    env,
    auth: {
      accessTtlSeconds: 15 * 60,
      refreshTtlDays: 30,
      otpLength: 6,
      otpTtlSeconds: 5 * 60,
      otpMaxAttempts: 5,
      otpMaxSendsPerWindow: 3,
      otpWindowSeconds: 15 * 60,
    },
    quoteTtlSeconds: 10 * 60,
    assignment: {
      offerTtlSeconds: 10 * 60,
      offerFanout: 2,
      maxCandidates: 20,
      defaultWindowMinutes: 120,
      straightLineFactor: 1.4,
      avgSpeedKmh: 20,
      weights: { language: 3, continuity: 4, rating: 2, load: 1, eta: 2 },
      etaCacheSeconds: 120,
    },
    duty: { idleTimeoutSeconds: 5 * 60, locationTtlSeconds: 5 * 60 },
    visitCodeMaxAttempts: 5,
    ambulance: { ackTimeoutSeconds: 45, emergencyNumber: '108' },
    pingRetentionDays: 30,
    rateLimit: { authedPerMinute: 300, publicPerMinute: 60 },
    defaultPlatformFeeBps: 2000,
    timezone: 'Asia/Kolkata',
  };
}

function assertProductionSafe(env: Env) {
  const devDefaults = ['dev-only', Buffer.alloc(32, 7).toString('base64')];
  for (const k of ['JWT_SECRET', 'QUOTE_SECRET', 'OTP_PEPPER', 'DATA_ENCRYPTION_KEY', 'PAYMENT_WEBHOOK_SECRET'] as const) {
    if (devDefaults.some((d) => env[k].includes(d))) throw new Error(`${k} must be set in production`);
  }
  if (env.SMS_PROVIDER === 'console') throw new Error('SMS_PROVIDER=console is not allowed in production');
  if (env.WHATSAPP_PROVIDER === 'console') throw new Error('WHATSAPP_PROVIDER=console is not allowed in production (use meta or off)');
  if (env.PAYMENT_GATEWAY === 'fake') throw new Error('PAYMENT_GATEWAY=fake is not allowed in production');
  if (env.STORAGE_DRIVER === 'local') throw new Error('STORAGE_DRIVER=local is not allowed in production');
  if (env.INLINE_JOBS) throw new Error('INLINE_JOBS is not allowed in production');
}
