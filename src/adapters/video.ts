import { randomUUID } from 'node:crypto';

export interface VideoAdapter {
  createRoom(purpose: string, startsAt: Date, endsAt: Date): Promise<{ roomId: string }>;
  joinToken(roomId: string, userId: string, role: 'host' | 'guest'): Promise<string>;
}

/** Placeholder video provider; swap for a telemedicine-compliant vendor. */
export class StubVideoAdapter implements VideoAdapter {
  async createRoom() {
    return { roomId: `room_${randomUUID()}` };
  }
  async joinToken(roomId: string, userId: string, role: 'host' | 'guest') {
    return Buffer.from(JSON.stringify({ roomId, userId, role })).toString('base64url');
  }
}
