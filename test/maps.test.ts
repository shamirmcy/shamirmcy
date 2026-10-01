import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GoogleRoutesAdapter } from '../src/adapters/distance.js';
import { GooglePlacesAdapter } from '../src/adapters/places.js';
import { estimateEta } from '../src/modules/assignment/eta.js';
import { call, login, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());
afterEach(() => vi.unstubAllGlobals());

/** Replace fetch with a canned response and record the request. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('Google Routes API (ETA)', () => {
  it('sends a traffic-aware matrix request and reads duration/distance', async () => {
    const calls = stubFetch([{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: '1265s', distanceMeters: 5400 }]);
    const est = await new GoogleRoutesAdapter('KEY', 'TWO_WHEELER').estimate({ lat: 12.97, lng: 77.64 }, { lat: 12.93, lng: 77.62 });
    expect(est).toEqual({ meters: 5400, minutes: 22, source: 'api' });
    expect(calls[0]!.url).toBe('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('KEY');
    expect(headers['x-goog-fieldmask']).toContain('duration');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ travelMode: 'TWO_WHEELER', routingPreference: 'TRAFFIC_AWARE' });
    expect(sent.origins[0].waypoint.location.latLng).toEqual({ latitude: 12.97, longitude: 77.64 });
  });

  it('treats "no route" as a failure', async () => {
    stubFetch([{ condition: 'ROUTE_NOT_FOUND' }]);
    await expect(new GoogleRoutesAdapter('KEY').estimate({ lat: 1, lng: 1 }, { lat: 2, lng: 2 })).rejects.toThrow(/no route/);
  });

  it('ETA falls back to straight-line when the maps API fails', async () => {
    const original = env.ctx.adapters.distance;
    env.ctx.adapters.distance = new GoogleRoutesAdapter('KEY');
    stubFetch({ error: 'quota' }, 429);
    try {
      const est = await estimateEta(env.ctx, { lat: 12.901, lng: 77.601 }, { lat: 12.951, lng: 77.651 });
      expect(est.source).toBe('straight_line');
      expect(est.minutes).toBeGreaterThan(0);
    } finally {
      env.ctx.adapters.distance = original;
    }
  });
});

describe('Google Places (address search)', () => {
  it('autocomplete is restricted to India and parsed into suggestions', async () => {
    const calls = stubFetch({
      suggestions: [{ placePrediction: { placeId: 'ChIJ1', text: { text: 'Indiranagar, Bengaluru' }, structuredFormat: { mainText: { text: 'Indiranagar' }, secondaryText: { text: 'Bengaluru, Karnataka' } } } }],
    });
    const s = await new GooglePlacesAdapter('KEY').autocomplete('indira', 'session-123456', { lat: 12.97, lng: 77.64 });
    expect(s).toEqual([{ place_id: 'ChIJ1', title: 'Indiranagar', subtitle: 'Bengaluru, Karnataka' }]);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ input: 'indira', sessionToken: 'session-123456', includedRegionCodes: ['in'] });
    expect(sent.locationBias.circle.center).toEqual({ latitude: 12.97, longitude: 77.64 });
  });

  it('place details give coordinates and pincode', async () => {
    stubFetch({
      id: 'ChIJ1',
      displayName: { text: '12th Main Road' },
      formattedAddress: '12th Main Road, Indiranagar, Bengaluru, Karnataka 560038, India',
      location: { latitude: 12.9716, longitude: 77.6411 },
      addressComponents: [
        { longText: 'Indiranagar', types: ['sublocality_level_1', 'sublocality'] },
        { longText: 'Bengaluru', types: ['locality'] },
        { longText: '560038', types: ['postal_code'] },
      ],
    });
    const a = await new GooglePlacesAdapter('KEY').details('ChIJ1', 'session-123456');
    expect(a).toMatchObject({ line1: '12th Main Road', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', lat: 12.9716, lng: 77.6411 });
  });

  it('reverse geocoding reads the first result', async () => {
    const calls = stubFetch({
      results: [{ place_id: 'P1', formatted_address: 'Domlur Layout, Bengaluru, Karnataka 560071, India', address_components: [{ long_name: '560071', types: ['postal_code'] }, { long_name: 'Bengaluru', types: ['locality'] }] }],
    });
    const a = await new GooglePlacesAdapter('KEY').reverse({ lat: 12.96, lng: 77.638 });
    expect(a).toMatchObject({ pincode: '560071', city: 'Bengaluru', line1: 'Domlur Layout', lat: 12.96 });
    expect(calls[0]!.url).toContain('latlng=12.96%2C77.638');
    expect(calls[0]!.url).toContain('region=in');
  });
});

describe('address search endpoints', () => {
  it('suggest → pick → serviceable, and outside areas are flagged', async () => {
    const pt = await login(env, 'patient');
    expect((await call(env, 'GET', '/places/autocomplete?q=indira&session_token=abcdef123')).status).toBe(401); // signed-in only
    const s = await call(env, 'GET', '/places/autocomplete?q=indira&session_token=abcdef123', { token: pt.token });
    expect(s.body.suggestions.length).toBeGreaterThan(0);
    const d = await call(env, 'GET', `/places/${s.body.suggestions[0].place_id}?session_token=abcdef123`, { token: pt.token });
    expect(d.body).toMatchObject({ serviceable: true, zone: 'Indiranagar, Bengaluru', address: { pincode: '560038' } });

    const k = await call(env, 'GET', '/places/dev-koramangala?session_token=abcdef123', { token: pt.token });
    expect(k.body).toMatchObject({ serviceable: false, zone: null });

    const r = await call(env, 'GET', '/places/reverse?lat=10.9602&lng=79.3787', { token: pt.token });
    expect(r.body).toMatchObject({ serviceable: true, zone: 'Kumbakonam Town, Kumbakonam', address: { pincode: '612001', lat: 10.9602 } });

    expect((await call(env, 'GET', '/places/reverse?lat=28.6&lng=77.2', { token: pt.token })).status).toBe(404);
  });
});
