import { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import type pg from 'pg';
import type { AppConfig } from './config.js';
import { createPool } from './lib/db.js';
import { FieldCipher } from './lib/crypto.js';
import { ConsoleSmsAdapter, Msg91SmsAdapter, type SmsAdapter } from './adapters/sms.js';
import { ConsoleWhatsAppAdapter, DisabledWhatsAppAdapter, MetaWhatsAppAdapter, type WhatsAppAdapter } from './adapters/whatsapp.js';
import { ConsolePushAdapter, FcmPushAdapter, type PushAdapter } from './adapters/push.js';
import { LocalStorageAdapter, S3StorageAdapter, type StorageAdapter } from './adapters/storage.js';
import { GoogleRoutesAdapter, StraightLineDistanceAdapter, type DistanceAdapter } from './adapters/distance.js';
import { GooglePlacesAdapter, OfflinePlacesAdapter, type PlacesAdapter } from './adapters/places.js';
import { FakePaymentGateway, RazorpayGateway, type PaymentGateway } from './adapters/payments.js';
import { BasicOcrAdapter, type OcrAdapter } from './adapters/ocr.js';
import { StubVideoAdapter, type VideoAdapter } from './adapters/video.js';
import { RealtimePublisher } from './realtime/publisher.js';
import { BullJobRunner, InlineJobRunner, type JobRunner } from './jobs/runner.js';
import { jobHandlers } from './jobs/handlers.js';

export interface Adapters {
  sms: SmsAdapter;
  whatsapp: WhatsAppAdapter;
  push: PushAdapter;
  storage: StorageAdapter;
  distance: DistanceAdapter;
  places: PlacesAdapter;
  /** Fallback when the primary distance API fails. */
  straightLine: DistanceAdapter;
  payments: PaymentGateway;
  ocr: OcrAdapter;
  video: VideoAdapter;
}

export interface Ctx {
  config: AppConfig;
  db: pg.Pool;
  redis: Redis;
  cipher: FieldCipher;
  adapters: Adapters;
  jobs: JobRunner;
  realtime: RealtimePublisher;
  log: Logger;
}

/**
 * Logger with health-data redaction. Request/response bodies are never logged; known sensitive
 * keys are censored if they ever appear in a log object.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.phone',
        '*.phone_e164',
        '*.code',
        '*.otp',
        '*.symptoms',
        '*.note',
        '*.notes',
        '*.diagnosis',
        '*.advice',
        '*.vitals',
        '*.conditions',
        '*.allergies',
        '*.items',
        '*.lat',
        '*.lng',
      ],
      censor: '[redacted]',
    },
  });
}

export function buildAdapters(config: AppConfig): Adapters {
  const e = config.env;
  // Dev/test only: the latest OTP per phone from either console channel (shown on the /dev page).
  const devInbox = new Map<string, string>();
  const echo = e.NODE_ENV === 'development';
  const straightLine = new StraightLineDistanceAdapter(config.assignment.straightLineFactor, config.assignment.avgSpeedKmh);
  return {
    sms: e.SMS_PROVIDER === 'msg91' ? new Msg91SmsAdapter(req(e.MSG91_AUTH_KEY, 'MSG91_AUTH_KEY'), req(e.MSG91_OTP_TEMPLATE_ID, 'MSG91_OTP_TEMPLATE_ID')) : new ConsoleSmsAdapter(devInbox, echo),
    whatsapp:
      e.WHATSAPP_PROVIDER === 'meta'
        ? new MetaWhatsAppAdapter(req(e.WHATSAPP_TOKEN, 'WHATSAPP_TOKEN'), req(e.WHATSAPP_PHONE_NUMBER_ID, 'WHATSAPP_PHONE_NUMBER_ID'), e.WHATSAPP_OTP_TEMPLATE, req(e.WHATSAPP_APP_SECRET, 'WHATSAPP_APP_SECRET'))
        : e.WHATSAPP_PROVIDER === 'off'
          ? new DisabledWhatsAppAdapter()
          : new ConsoleWhatsAppAdapter(devInbox, echo, e.WHATSAPP_APP_SECRET ?? 'dev-only-whatsapp-secret'),
    push:
      e.PUSH_PROVIDER === 'fcm'
        ? new FcmPushAdapter(req(e.FCM_PROJECT_ID, 'FCM_PROJECT_ID'), async () => req(e.FCM_ACCESS_TOKEN, 'FCM_ACCESS_TOKEN'))
        : new ConsolePushAdapter(),
    storage: e.STORAGE_DRIVER === 's3' ? new S3StorageAdapter(req(e.S3_BUCKET, 'S3_BUCKET'), e.S3_REGION, e.S3_ENDPOINT) : new LocalStorageAdapter(e.STORAGE_LOCAL_DIR, e.PUBLIC_BASE_URL),
    distance: e.MAPS_PROVIDER === 'google' ? new GoogleRoutesAdapter(req(e.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY'), e.MAPS_TRAVEL_MODE) : straightLine,
    places: e.MAPS_PROVIDER === 'google' ? new GooglePlacesAdapter(req(e.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY')) : new OfflinePlacesAdapter(),
    straightLine,
    payments:
      e.PAYMENT_GATEWAY === 'razorpay'
        ? new RazorpayGateway(req(e.RAZORPAY_KEY_ID, 'RAZORPAY_KEY_ID'), req(e.RAZORPAY_KEY_SECRET, 'RAZORPAY_KEY_SECRET'), e.PAYMENT_WEBHOOK_SECRET)
        : new FakePaymentGateway(e.PAYMENT_WEBHOOK_SECRET),
    ocr: new BasicOcrAdapter(),
    video: new StubVideoAdapter(),
  };
}

function req(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required for the selected adapter`);
  return v;
}

export function redisConnectionOptions(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    db: Number(u.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
}

export function createCtx(config: AppConfig, overrides: Partial<Adapters> = {}): Ctx {
  const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const adapters = { ...buildAdapters(config), ...overrides };
  const ctx: Ctx = {
    config,
    db: createPool(config.env.DATABASE_URL),
    redis,
    cipher: new FieldCipher(config.env.DATA_ENCRYPTION_KEY),
    adapters,
    jobs: undefined as unknown as JobRunner,
    realtime: new RealtimePublisher(redis),
    log: createLogger(config.env.LOG_LEVEL),
  };
  if (config.env.INLINE_JOBS) {
    const runner = new InlineJobRunner(jobHandlers);
    runner.ctx = ctx;
    ctx.jobs = runner;
  } else {
    ctx.jobs = new BullJobRunner(redisConnectionOptions(config.env.REDIS_URL));
  }
  return ctx;
}

export async function closeCtx(ctx: Ctx) {
  await ctx.jobs.close();
  await ctx.db.end();
  ctx.redis.disconnect();
}
