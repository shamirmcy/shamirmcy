import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import type { Ctx } from '../context.js';
import { verifyAccessToken, type AuthInfo } from '../plugins/auth.js';
import { RT_BUS, type RealtimeEvent } from './publisher.js';

/**
 * WebSocket gateway: GET /v1/realtime?token=<access token>
 * Client → server: {"type":"resume","channel":"patient:<id>","after_seq":41}
 * Server → client: RealtimeEvent {channel, seq, type, payload, at}; on gaps beyond the replay
 * buffer the server sends {"type":"resync","channel"} and the client should refetch state.
 */
export async function realtimeGateway(app: FastifyInstance, ctx: Ctx) {
  const subscribers = new Map<string, Set<WebSocket>>();
  const sub = new Redis(ctx.config.env.REDIS_URL, { maxRetriesPerRequest: null });
  await sub.subscribe(RT_BUS);
  sub.on('message', (_ch, raw) => {
    const ev = JSON.parse(raw) as RealtimeEvent;
    for (const ws of subscribers.get(ev.channel) ?? []) if (ws.readyState === 1) ws.send(raw);
  });
  app.addHook('onClose', async () => sub.disconnect());

  const channelsFor = (a: AuthInfo) => {
    const ch: string[] = [];
    if (a.app === 'patient') ch.push(ctx.realtime.patientChannel(a.userId));
    if (a.app === 'provider' && a.providerId) ch.push(ctx.realtime.providerChannel(a.providerId));
    if (a.app === 'ops') ch.push('ops');
    return ch;
  };

  app.get('/v1/realtime', { websocket: true, config: { public: true }, schema: { hide: true } }, async (socket, req) => {
    let auth: AuthInfo;
    try {
      auth = await verifyAccessToken(ctx, String((req.query as Record<string, string>).token ?? ''));
    } catch {
      socket.close(4401, 'unauthenticated');
      return;
    }
    const allowed = channelsFor(auth);
    for (const ch of allowed) {
      if (!subscribers.has(ch)) subscribers.set(ch, new Set());
      subscribers.get(ch)!.add(socket);
    }
    socket.send(JSON.stringify({ type: 'hello', channels: allowed }));
    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; channel: string; after_seq: number };
        if (msg.type !== 'resume' || !allowed.includes(msg.channel)) return;
        const { events, gap } = await ctx.realtime.replay(msg.channel, Number(msg.after_seq) || 0);
        if (gap) socket.send(JSON.stringify({ type: 'resync', channel: msg.channel }));
        for (const e of events) socket.send(JSON.stringify(e));
      } catch {
        /* ignore malformed client frames */
      }
    });
    socket.on('close', () => {
      for (const ch of allowed) subscribers.get(ch)?.delete(socket);
    });
  });
}
