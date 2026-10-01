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

/**
 * Google Routes API (computeRouteMatrix), traffic-aware. Server-side only; the key never reaches clients.
 * TWO_WHEELER is available in India and suits professionals on scooters.
 */
export class GoogleRoutesAdapter implements DistanceAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly travelMode: 'DRIVE' | 'TWO_WHEELER' = 'DRIVE',
  ) {}
  async estimate(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const point = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
        'x-goog-fieldmask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
      },
      body: JSON.stringify({ origins: [point(from)], destinations: [point(to)], travelMode: this.travelMode, routingPreference: 'TRAFFIC_AWARE' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Routes API ${res.status}`);
    const rows = (await res.json()) as Array<{ condition?: string; duration?: string; distanceMeters?: number }>;
    const el = rows[0];
    if (!el || el.condition !== 'ROUTE_EXISTS' || !el.duration) throw new Error(`Routes API: no route (${el?.condition})`);
    const secs = Number(el.duration.replace(/s$/, ''));
    return { meters: el.distanceMeters ?? 0, minutes: Math.max(1, Math.ceil(secs / 60)), source: 'api' };
  }
}
