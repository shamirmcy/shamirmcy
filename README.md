# KM DocH — Doctor At Your Home · Backend

Production backend for KM DocH, a home-healthcare mediator in India. It connects patients with licensed doctors, nurses, technicians, caregivers, labs, equipment suppliers and ambulance partners, and publishes a fixed price for every service.

**Stack:** Node.js 20 · TypeScript (strict) · Fastify 5 · Zod · OpenAPI 3.1 · PostgreSQL 16 + PostGIS · Redis 7 · BullMQ · WebSockets · S3-compatible storage

The design review the spec asks for (data model restated, plus what is unsafe, unclear or overbuilt) is in [`docs/DESIGN.md`](docs/DESIGN.md). Read it first.

## Quick start

```bash
docker compose up -d db redis          # PostGIS 16 + Redis 7
cp .env.example .env                   # dev defaults work as-is
npm install
npm run migrate && npm run seed -- --demo
npm run dev                            # API on :3000, OTPs are printed to the console in development
npm run worker:dev                     # BullMQ worker + schedules (or set INLINE_JOBS=true to run jobs in the API)
```

To run everything in containers: `docker compose up --build`.

- API docs: `GET /v1/openapi.json` (also `npm run openapi` writes `openapi.json`)
- Health: `GET /healthz`
- Realtime: `ws://host/v1/realtime?token=<access token>`

## Tests

```bash
npm test         # needs Postgres+PostGIS and Redis; uses kmdoch_test and Redis db 15
npm run typecheck
```

`test/acceptance.test.ts` covers the ten acceptance tests in spec §13, one test per item. `test/features.test.ts` covers multi-visit series, estimate true-up with automatic refunds, provider cancellation with re-assignment, and ratings. `test/scheduling-billing.test.ts` covers double-booking protection, rescheduling, PDF receipts, refund retries and rate limits. `test/flows.test.ts` runs the end-to-end flows: auth rotation, the full visit lifecycle through invoice and payout, multi-provider and first-dose visits, the photo prescription → pharmacist → Schedule H dispatch flow, webhooks and refunds, ambulance dispatch and ack timeout, the jobs, and the WebSocket gateway. Tests run against real Postgres/PostGIS and Redis. Nothing is mocked except the external vendors (SMS, payments, storage), which use dev adapters.

| §13 | Test |
|---|---|
| 1 | Tracking for doctor, nurse, technician and caregiver visits checked at schema level and against live responses and realtime events: no coordinates, route or distance |
| 2 | Missing or out-of-date consent → `CONSENT_REQUIRED`, and no draft is left behind |
| 3 | `TERMS_REQUIRED`, including after ops publishes a new version |
| 4 | Two providers accept at the same time → one `200`, one `ALREADY_ASSIGNED` |
| 5 | IV care and nurse injection without a prescription → `PRESCRIPTION_REQUIRED` |
| 6 | Signed prescription: API edit returns `PRESCRIPTION_LOCKED`, direct SQL update/delete is blocked by trigger, correction supersedes it |
| 7 | Client prices ignored, forged quote token rejected |
| 8 | Family member without `can_view_records` → 403, and the attempt is logged in `record_access_log` |
| 9 | No pings stored while off duty; last location wiped when going off duty |
| 10 | Ambulance dispatched even when the gateway fails and the account is blocked |

## Layout

```
src/
  app.ts, server.ts, worker.ts      Fastify app, API entry, BullMQ worker entry
  config.ts, context.ts             env config (prod refuses dev secrets/adapters), DI context
  db/migrations/001_init.sql        full schema, triggers, partition functions
  db/migrate.ts, db/seed.ts         forward-only migrator; catalogue, consents, terms, rules, content
  adapters/                         sms (console|MSG91), push (console|FCM), storage (local|S3),
                                    distance (straight-line|Google), payments (fake|Razorpay), ocr, video
  plugins/auth.ts, idempotency.ts   JWT auth (15 min) + device check; Idempotency-Key handling
  realtime/                         Redis-backed publisher with per-channel seq + replay; WS gateway
  jobs/                             BullMQ / inline runners, handlers, schedules (IST cron)
  modules/
    auth/        OTP, refresh rotation, /me
    catalogue/   service definitions (code) + prices (DB), signed quotes
    consents/    templates, recording, withdrawal
    requests/    state machine (transition()), booking + visit schedule, privacy-safe tracking, cancel/skip, ratings
    assignment/  candidates, ETA (cached, with fallback), ranking, offers, accept lock, expiry
    providers/   duty, location, terms, today, request view (area only until accepted), profile, bio, fees, payouts
    visits/      on-my-way, door code per visit, start, complete (series aware), actual costs, provider cancel, missed-visit sweep
    clinical/    consultations, typed/photo prescriptions, alerts, PDF, OCR, transcription
    records/     health records, unified orders
    commerce/    pharmacy, rentals, ambulance, payments, webhooks, refunds, billing, settlement (final bill + auto-refund)
    partners/    pharmacist / lab / equipment / ambulance crew endpoints
    ops/         verification, live board, manual assignment, catalogue, consents/terms, bios, refunds, partners (audited)
    notifications/  en/ta/kn/hi templates; push → SMS → voice
```

## Sign-in

`POST /v1/auth/otp/request {phone, app_role}`, where `app_role` is `patient | provider | partner | ops`. Provider sign-in also sends `provider_role` and `reg_number`. The first provider sign-in creates a `pending` provider, and ops must verify it before the provider can go on duty. Ops sign-in is limited to phones that already hold `ops_admin` or are listed in `OPS_ADMIN_PHONES`. Partner sign-in needs a membership created by ops.

## Production checklist

- Set all secrets. The app refuses to boot in `NODE_ENV=production` with dev secrets or the console, fake or local adapters.
- Turn on Postgres volume encryption and TLS, and use a private S3 bucket with SSE (presigned URLs only).
- Run `node dist/db/migrate.js` before deploying. Run at least one `dist/worker.js`. Put the API behind TLS.
- Fill in the open items in `docs/DESIGN.md §4`.
