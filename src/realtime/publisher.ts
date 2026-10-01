import type { Redis } from 'ioredis';

export const RT_BUS = 'rt:bus';
const LOG_LEN = 200;

export interface RealtimeEvent {
  channel: string;
  seq: number;
  type: string;
  payload: unknown;
  at: string;
}

/** Event types on patient channels that may legitimately carry a live position. */
const LIVE_MAP_EVENTS = new Set(['delivery.location', 'ambulance.location']);
const LOCATION_KEYS = /^(lat|lng|lon|latitude|longitude|location|coords|coordinates|route|polyline|heading|bearing|distance|distance_m|distance_km|path)$/i;

/** Defence in depth: strip anything location-like from patient-channel events except live-map events. */
export function stripLocation(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripLocation);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !LOCATION_KEYS.test(k))
        .map(([k, val]) => [k, stripLocation(val)]),
    );
  }
  return v;
}

export class RealtimePublisher {
  constructor(private readonly redis: Redis) {}

  async publish(channel: string, type: string, payload: unknown): Promise<RealtimeEvent> {
    const safe = channel.startsWith('patient:') && !LIVE_MAP_EVENTS.has(type) ? stripLocation(payload) : payload;
    const seq = await this.redis.incr(`rt:seq:${channel}`);
    const event: RealtimeEvent = { channel, seq, type, payload: safe, at: new Date().toISOString() };
    const raw = JSON.stringify(event);
    await this.redis
      .multi()
      .lpush(`rt:log:${channel}`, raw)
      .ltrim(`rt:log:${channel}`, 0, LOG_LEN - 1)
      .expire(`rt:log:${channel}`, 86400)
      .publish(RT_BUS, raw)
      .exec();
    return event;
  }

  /** Events after `afterSeq`, oldest first — used to fill gaps after reconnect. */
  async replay(channel: string, afterSeq: number): Promise<{ events: RealtimeEvent[]; gap: boolean }> {
    const raw = await this.redis.lrange(`rt:log:${channel}`, 0, LOG_LEN - 1);
    const events = raw.map((r) => JSON.parse(r) as RealtimeEvent).filter((e) => e.seq > afterSeq).reverse();
    const gap = events.length > 0 && events[0]!.seq !== afterSeq + 1;
    return { events, gap };
  }

  patientChannel(userId: string) {
    return `patient:${userId}`;
  }
  providerChannel(providerId: string) {
    return `provider:${providerId}`;
  }
}
