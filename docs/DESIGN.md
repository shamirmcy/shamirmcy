# KM DocH backend — design notes and review

Spec §14 asks to restate the data model and flag anything unsafe, unclear or overbuilt. This document does that, records the interpretations made where the spec was ambiguous, and lists what is still open.

## 1. Data model (as built)

Schema: `src/db/migrations/` (`001_init.sql`, `002_series_ratings_adjustments.sql`, `003_clashes_reschedule_receipts_refund_retry.sql`). UUIDv7 keys (`uuid_generate_v7()` in SQL), `created_at`/`updated_at` everywhere, `deleted_at` on user-owned rows, money in integer paise, times in `timestamptz` (UTC).

| Area | Tables | Notes |
|---|---|---|
| Identity | `users`, `user_roles`, `devices`, `refresh_tokens`, `otp_challenges` | Phone (+91, 10 digits, CHECK constraint) is the identity. Refresh tokens rotate within a *family* bound to a device; reuse of a spent token revokes the family. |
| Geography | `service_zones` | PostGIS multipolygon + pincode list. Serviceability = polygon covers the address OR pincode matches. |
| Patients | `patients`, `family_links`, `addresses` | The account holder's own profile is a `patients` row linked with relationship `self`. Dependants have `user_id = NULL`. `conditions`/`allergies` are encrypted. |
| Providers | `providers`, `provider_bios`, `provider_documents`, `provider_sessions`, `location_pings` | `provider_sessions` is the duty/location state; a Redis copy (`prov:loc:{id}`, 5-min TTL) is the hot presence. `location_pings` is partitioned by day and dropped after 30 days. |
| Consent / terms | `consent_templates`, `consents`, `provider_terms`, `provider_terms_acceptances` | Versioned; new versions are inserted, never edited. Consents record timestamp, version, IP and device. |
| Catalogue | `services`, `service_options`, `quotes` | Prices and `payout_rule` live in `service_options` (editable by ops). Service *structure* (which options a service combines, which roles it needs) lives in code: `src/modules/catalogue/defs.ts`. |
| Requests | `service_requests`, `visit_occurrences`, `request_adjustments`, `ratings`, `provider_cancellations`, `request_slots`, `request_assignments`, `request_events`, `visit_codes`, `request_attachments`, `video_sessions` | **Added `request_slots`**: one row per role needed for a visit (e.g. consultant lead + nurse assist). An assignment fills a slot; a partial unique index guarantees one accepted assignment per slot. `request_events` is append-only (trigger). |
| Clinical | `consultations`, `prescriptions`, `prescription_items`, `prescription_photos`, `clinical_rules`, `clinical_alerts`, `lab_orders`, `lab_results` | Clinical text is AES-256-GCM encrypted in the app (`*_enc`). Triggers make signed prescriptions and their items immutable and undeletable. |
| Partners | `partners`, `partner_members`, `facilities`, `ambulance_vehicles` | **Added** — the spec names partners as a role but needs an organisation + membership model (pharmacist, crew…). |
| Commerce | `medicines`, `pharmacy_orders`, `pharmacy_order_items`, `equipment_rentals`, `ambulance_runs`, `payments`, `payment_webhook_events`, `refunds`, `invoices`, `payout_lines`, `payouts` | **Added `payout_lines`** (per-visit ledger) so weekly `payouts` are a roll-up, and `payment_webhook_events` for webhook de-duplication. |
| Platform | `idempotency_keys`, `audit_log`, `record_access_log`, `notifications`, `content_blocks`, `app_config`, `uploads` | `audit_log` and `record_access_log` are append-only (triggers). `content_blocks` holds the responsibility model as data. |

### Request lifecycle

`src/modules/requests/state.ts` holds the transition table and the single `transition()` function (row lock → table check → guards → update → event row → post-commit realtime/notifications). Guards on `draft → requested`: required consents at the current version, and prescription evidence for services that need it.

One deviation from the spec diagram: `confirmed → assigning` and `no_provider → assigning` are allowed so a visit can be re-assigned (ops manual assignment, "schedule later").

## 2. How the non-negotiables are enforced

| Rule | Enforcement |
|---|---|
| Health data regulated | Field-level AES-GCM for clinical text (`FieldCipher`), TLS assumed at the edge, every clinical read and denial written to `record_access_log`, pino redaction + request bodies never logged, notification copy never contains clinical detail. |
| Provider location privacy | Pings rejected unless on duty with consent; going off duty / withdrawing consent wipes `last_location`; patient tracking uses a **strict Zod response schema** (unknown keys stripped on serialisation); patient realtime channel strips location-like keys except `delivery.location`/`ambulance.location`; idle reaper. |
| Prescriptions immutable | API (`PRESCRIPTION_LOCKED`) **and** DB triggers on `prescriptions` and `prescription_items`; corrections via `supersedes_id` (+ unique index: one successor). |
| Consent before booking | `recordRequestConsents` + transition guard; failure rolls back the whole booking (nothing left in `draft`). |
| Terms before duty | `setDuty` checks the latest version for the role; the candidate query also joins the current-version acceptance. |
| Emergencies never blocked | Ambulance: no account-status check, pricing errors swallowed, payment best-effort after dispatch. ALS bypasses the account-status check. |
| Idempotency | `Idempotency-Key` required on booking, cancel, accept/decline, complete, payments, pharmacy, rentals, ambulance, refunds, manual assignment. Same key + different body → `IDEMPOTENCY_KEY_REUSED`. |
| Money / time / phone | Integer paise everywhere; `timestamptz`; IST only in formatting (PDF, cron schedules); phone normalised to E.164 with a DB CHECK. |

## 3. Flags

### Unsafe — needs a decision

1. **Rule 4 vs rule 6 for the ALS emergency team.** ALS is a service request, so it currently requires the three consents (rule 4). Rule 6 says emergencies are never blocked. Today the app must collect a one-tap consent; the business should decide whether emergencies proceed on implied consent with consent captured afterwards. (Ambulance runs are not service requests and are never blocked.)
2. **Patient-uploaded prescription photos authorise injections/IV.** Nothing verifies that photo before a nurse injects. Recommend that the nurse confirms the photo against the medicine in hand (or a doctor tele-confirms) before `start`, and that the photo goes through the same pharmacist check as doctor photos.
3. **Remote first-dose supervision.** The spec says to *record* that the doctor joined. I went further: the nurse cannot `start` until the remote doctor has joined (`SUPERVISOR_NOT_JOINED`). Confirm this matches clinical policy.
4. **Contact phone after acceptance.** Providers see the booker's real phone number after accepting. Recommend number masking (call bridging) to protect both sides.
5. **Door code readable by the patient later.** To show it again in the app it is stored encrypted as well as hashed. If that is not wanted, send it once by push/SMS and keep the hash only.
6. **Psychiatry notes.** They are hidden from everyone but the authoring consultant, **including the patient's record view**. A patient's right to access their own data (DPDP) may require otherwise — needs legal review.
7. **Adult dependants.** An account holder can create a dependant profile and see their records. For adults that should need the dependant's own consent. Linking someone who has their own account is not built; those people control their own profile.
8. **No ops access to clinical records** (by design). Complaints and medico-legal cases will need an audited break-glass process.
9. **30-day ping retention** is longer than "only to calculate arrival time" needs. Consider 7 days unless the pings are needed for disputes.

### Unclear — interpretation chosen

| Item | Interpretation (all prices editable by ops) |
|---|---|
| IV "with your doctor +₹599 + ₹399" | ₹399 is the nurse visit itself: total = ₹399 visit + ₹599 doctor + kit. |
| Safe first-dose team ₹999 | Split technician ₹600 + nurse ₹399 so each is paid; later visits ₹399. |
| Kit "up to ₹600", antibiotic "about ₹250", materials "~₹120" | Lines flagged `meta.estimate`. The quote is charged up front; the professional records the actual cost (`POST /provider/visits/:id/actuals`, never above the quote — KM DocH absorbs any excess); settlement bills the lower figure and auto-refunds the difference. |
| Dressing materials, lab test fees, kits, equipment | `payee_role = null` → platform/partner revenue; partner settlement is out of scope. ECG paid to the lab technician at 20%. |
| Multi-visit services (dressing ×5/×7, elder care week/month) | One request, many `visit_occurrences`, one provider for continuity. Dressing: first visit ASAP (or `scheduled_for`), then daily / every 2 days. Elder care: one shift per day from `start_date` at 10 am or 9 pm IST. Each visit has its own door code; after each visit the request returns to `confirmed`. Patients can skip a visit or stop the series; only completed visits are billed and paid out. Visits >6 h overdue are marked missed (hourly sweep, ops alerted). |
| Payment timing | Not specified. Booking is never blocked on payment; patients can pay by UPI/card at any time or by cash. `POST /payments` charges what is still due (settled total once known, else the quote, minus anything captured). |
| Ratings | One rating per professional per request, after at least one completed visit. Feeds `providers.rating_avg` (used in ranking). Providers see average, count and star breakdown only. ≤2 stars alerts ops. |
| Cancellation after `confirmed` | Fee from `app_config.cancellation_fee_after_confirmed_paise` (seeded 0). |
| Provider cancelling a confirmed visit | `POST /provider/requests/:id/cancel` (before arrival only) cancels their assignment and moves the request back to `assigning`; the engine re-offers it to others (never the canceller), else `no_provider`. 3+ cancellations in 30 days alert ops. The terminal `cancelled_by_provider` status is kept but unused. |
| `reviewing` triage | Off by default; enable per service via `app_config.triage_services`, then ops approves. |
| Specialist video slot | Consultant is `lead` + remote; nurse is `assist` in person; the slot time becomes `scheduled_for`. |
| Overlapping jobs | "No overlapping job" = no active in-person job now. A visit booked for later (>2 h) only holds the provider once they tap **on my way** (`POST /provider/visits/:id/on-my-way`), which also starts the patient's minutes-only ETA. Clashes between two future bookings are not checked. |
| Lab partner | Assigned when results are posted (first lab to report), not at booking. |

### Overbuilt — kept, but could be simpler

- **Daily partitions for `location_pings`**: a plain table with a nightly `DELETE` would do at launch volume. Kept because the spec asks for it and the cost is small.
- **OCR**: with a pharmacist transcribing every page anyway, OCR adds little at launch. It is behind an adapter that only does a quality check today.
- **Redis hot copy of provider location**: Postgres is authoritative and is what the candidate query uses. The Redis key is only presence with a TTL.
- **Redis `SET NX` on accept**: the partial unique index already guarantees one winner. The lock just fails losers faster.

## 4. Open items for the business (spec §15)

Partner-desk phone (`PARTNER_DESK_PHONE`), ambulance per-km rates (seeded placeholders flagged `meta.placeholder`), platform fee per service (all `payout_rule`s are editable), launch city/pincodes (demo zones: Indiranagar, Bengaluru and Kumbakonam Town), payment gateway (Razorpay adapter included), SMS/WhatsApp provider (MSG91 adapter included; WhatsApp and voice need the chosen vendor), FCM credentials, video vendor (stub adapter), OCR vendor (stub), payout rail for bank transfers (payouts are recorded as `sent` but no money moves yet).

## 5. Recently added

- **No double-booking**: each visit blocks a time window (`visit_occurrences.duration_minutes`: 90 min default, elder-care day 7 h / night 10 h, specialist 60 min). Providers with an overlapping accepted visit are never offered a request, and accepting is re-checked (`SCHEDULE_CLASH`).
- **Rescheduling**: `POST /service-requests/:id/visits/:seq/reschedule` (≥2 h ahead, ≤60 days, no overlap with the booking's other visits or the professional's other bookings, which are never revealed). The professional is notified.
- **PDF receipts**: `GET /invoices/:id/pdf`, generated once and stored privately. Tracking returns `invoice_id`. Tax details (GSTIN, SAC) are an **open item**.
- **Refund retries**: failed gateway refunds retry every 5, 10, 20, 40, 80 minutes (`refunds.retry` job). After 6 attempts they stop and alert ops. Refunds still being retried count against the payment, so the same money can't be refunded twice.
- **Rate limits**: 300 requests/minute per signed-in user, 60/minute per IP for public endpoints (`429` with `Retry-After`). Webhooks and health checks are exempt.

## 6. Not built yet

Number masking, WhatsApp/voice delivery, real OCR/video vendors, bank payout rail, an admin UI (ops is API-only), tax lines on receipts.
