import { haversineMeters, type LatLng } from '../lib/geo.js';

export interface RouteEstimate {
  meters: number;
  minutes: number;
  source: 'api' | 'straight_line';
}

/** Server-side only. Results are never forwarded to patients except as eta minutes. */
export interface DistanceAdapter {
  estimate(from: LatLng, to: LatLng): Promise<RouteEstimate>;
}

export class StraightLineDistanceAdapter implements DistanceAdapter {
  constructor(
    private readonly factor: number,
    private readonly speedKmh: number,
  ) {}
  async estimate(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const meters = Math.round(haversineMeters(from, to) * this.factor);
    return { meters, minutes: Math.max(1, Math.ceil(meters / 1000 / this.speedKmh * 60)), source: 'straight_line' };
  }
}

export class GoogleDistanceAdapter implements DistanceAdapter {
  constructor(private readonly apiKey: string) {}
  async estimate(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const u = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    u.searchParams.set('origins', `${from.lat},${from.lng}`);
    u.searchParams.set('destinations', `${to.lat},${to.lng}`);
    u.searchParams.set('departure_time', 'now');
    u.searchParams.set('key', this.apiKey);
    const res = await fetch(u, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Distance API ${res.status}`);
    const body = (await res.json()) as any;
    const el = body?.rows?.[0]?.elements?.[0];
    if (el?.status !== 'OK') throw new Error(`Distance API element ${el?.status}`);
    const secs = el.duration_in_traffic?.value ?? el.duration.value;
    return { meters: el.distance.value, minutes: Math.max(1, Math.ceil(secs / 60)), source: 'api' };
  }
}
