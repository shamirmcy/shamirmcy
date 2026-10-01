import type { LatLng } from '../lib/geo.js';

export interface PlaceSuggestion {
  place_id: string;
  title: string;
  subtitle: string;
}

export interface ResolvedAddress {
  place_id: string | null;
  formatted: string;
  line1: string;
  locality: string | null;
  city: string | null;
  pincode: string | null;
  lat: number;
  lng: number;
}

/** Address search for patients. Server-side only, so the maps key never ships in the app. */
export interface PlacesAdapter {
  autocomplete(query: string, sessionToken: string, near?: LatLng): Promise<PlaceSuggestion[]>;
  details(placeId: string, sessionToken: string): Promise<ResolvedAddress | null>;
  reverse(at: LatLng): Promise<ResolvedAddress | null>;
}

/** Google Places API (New) + Geocoding API, restricted to India. */
export class GooglePlacesAdapter implements PlacesAdapter {
  constructor(private readonly apiKey: string) {}

  async autocomplete(query: string, sessionToken: string, near?: LatLng) {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        input: query,
        sessionToken,
        includedRegionCodes: ['in'],
        ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30000 } } } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Places autocomplete ${res.status}`);
    const body = (await res.json()) as { suggestions?: Array<{ placePrediction?: { placeId: string; text?: { text: string }; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }> };
    return (body.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ place_id: p.placeId, title: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '', subtitle: p.structuredFormat?.secondaryText?.text ?? '' }));
  }

  async details(placeId: string, sessionToken: string) {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`, {
      headers: { 'x-goog-api-key': this.apiKey, 'x-goog-fieldmask': 'id,displayName,formattedAddress,location,addressComponents' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Place details ${res.status}`);
    const p = (await res.json()) as {
      id: string;
      displayName?: { text: string };
      formattedAddress: string;
      location: { latitude: number; longitude: number };
      addressComponents?: Array<{ longText: string; types: string[] }>;
    };
    const comp = (t: string) => p.addressComponents?.find((c) => c.types.includes(t))?.longText ?? null;
    return {
      place_id: p.id,
      formatted: p.formattedAddress,
      line1: p.displayName?.text ?? p.formattedAddress.split(',')[0]!,
      locality: comp('sublocality_level_1') ?? comp('sublocality') ?? comp('neighborhood'),
      city: comp('locality'),
      pincode: comp('postal_code'),
      lat: p.location.latitude,
      lng: p.location.longitude,
    };
  }

  async reverse(at: LatLng) {
    const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    u.searchParams.set('latlng', `${at.lat},${at.lng}`);
    u.searchParams.set('region', 'in');
    u.searchParams.set('key', this.apiKey);
    const res = await fetch(u, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Geocoding ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ place_id: string; formatted_address: string; address_components: Array<{ long_name: string; types: string[] }> }> };
    const r = body.results?.[0];
    if (!r) return null;
    const comp = (t: string) => r.address_components.find((c) => c.types.includes(t))?.long_name ?? null;
    return {
      place_id: r.place_id,
      formatted: r.formatted_address,
      line1: r.formatted_address.split(',')[0]!,
      locality: comp('sublocality_level_1') ?? comp('sublocality'),
      city: comp('locality'),
      pincode: comp('postal_code'),
      lat: at.lat,
      lng: at.lng,
    };
  }
}

/** Offline sample places for development and tests (no maps key needed). */
const SAMPLE: ResolvedAddress[] = [
  { place_id: 'dev-indiranagar-100ft', formatted: '100 Feet Road, Indiranagar, Bengaluru, Karnataka 560038', line1: '100 Feet Road', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', lat: 12.9719, lng: 77.6412 },
  { place_id: 'dev-hal-2nd-stage', formatted: 'HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560008', line1: 'HAL 2nd Stage', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560008', lat: 12.9784, lng: 77.6408 },
  { place_id: 'dev-domlur', formatted: 'Domlur Layout, Bengaluru, Karnataka 560071', line1: 'Domlur Layout', locality: 'Domlur', city: 'Bengaluru', pincode: '560071', lat: 12.9606, lng: 77.6386 },
  { place_id: 'dev-kumbakonam-temple', formatted: 'Big Street, Kumbakonam, Tamil Nadu 612001', line1: 'Big Street', locality: 'Kumbakonam', city: 'Kumbakonam', pincode: '612001', lat: 10.9601, lng: 79.3788 },
  { place_id: 'dev-koramangala', formatted: '80 Feet Road, Koramangala, Bengaluru, Karnataka 560034', line1: '80 Feet Road', locality: 'Koramangala', city: 'Bengaluru', pincode: '560034', lat: 12.9352, lng: 77.6245 },
];

export class OfflinePlacesAdapter implements PlacesAdapter {
  async autocomplete(query: string) {
    const q = query.toLowerCase();
    return SAMPLE.filter((p) => p.formatted.toLowerCase().includes(q)).map((p) => ({ place_id: p.place_id!, title: p.line1, subtitle: p.formatted.slice(p.line1.length + 2) }));
  }
  async details(placeId: string) {
    return SAMPLE.find((p) => p.place_id === placeId) ?? null;
  }
  async reverse(at: LatLng) {
    let best: ResolvedAddress | null = null;
    let bestD = Infinity;
    for (const p of SAMPLE) {
      const d = (p.lat - at.lat) ** 2 + (p.lng - at.lng) ** 2;
      if (d < bestD) (best = p), (bestD = d);
    }
    return best && bestD < 0.01 ? { ...best, lat: at.lat, lng: at.lng } : null;
  }
}
