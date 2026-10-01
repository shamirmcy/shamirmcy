-- KM DocH core schema.
-- Conventions: UUIDv7 primary keys, timestamptz in UTC, money as integer paise,
-- soft deletes (deleted_at) on user-owned rows. Clinical free text is encrypted
-- in the application layer (columns suffixed _enc) before it reaches the database.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- UUIDv7: 48-bit unix ms timestamp + random bits (RFC 9562).
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
DECLARE
  ts bytea := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  rnd bytea := gen_random_bytes(10);
BEGIN
  rnd := set_byte(rnd, 0, (get_byte(rnd, 0) & 15) | 112);   -- version 7
  rnd := set_byte(rnd, 2, (get_byte(rnd, 2) & 63) | 128);   -- variant 10
  RETURN encode(ts || rnd, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY: % is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;

-- ───────────────────────────── Identity ─────────────────────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+91[6-9][0-9]{9}$'),
  name text,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','ta','kn','hi')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('patient','doctor','staff_nurse','critical_care_technician','lab_technician',
                                     'caregiver','consultant','partner','ops_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users(id),
  client_device_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios','web')),
  push_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, client_device_id)
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  device_id uuid NOT NULL REFERENCES devices(id),
  family_id uuid NOT NULL,
  app text NOT NULL CHECK (app IN ('patient','provider','partner','ops')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('patient','provider','partner','ops')),
  meta jsonb NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenges (phone_e164, created_at DESC);

-- ───────────────────────────── Geography ─────────────────────────────
CREATE TABLE service_zones (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name text NOT NULL,
  city text NOT NULL,
  pincodes text[] NOT NULL DEFAULT '{}',
  area geography(MultiPolygon, 4326),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON service_zones USING gist (area);

-- ───────────────────────────── Patients and family ─────────────────────────────
CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid UNIQUE REFERENCES users(id),           -- null for dependants without their own login
  name text NOT NULL,
  dob date,
  sex text CHECK (sex IN ('female','male','other')),
  conditions_enc text,                                 -- encrypted JSON string[]
  allergies_enc text,                                  -- encrypted JSON string[]
  abha_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE family_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  account_holder_id uuid NOT NULL REFERENCES users(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  relationship text NOT NULL,
  can_book boolean NOT NULL DEFAULT true,
  can_view_records boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX family_links_unique ON family_links (account_holder_id, patient_id) WHERE deleted_at IS NULL;

CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid NOT NULL REFERENCES patients(id),
  label text NOT NULL,
  line1 text NOT NULL,
  landmark text,
  locality text,
  pincode text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  location geography(Point, 4326) NOT NULL,
  gate_code text,
  floor text,
  lift boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ───────────────────────────── Providers ─────────────────────────────
CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('doctor','staff_nurse','critical_care_technician','lab_technician','caregiver','consultant')),
  reg_type text NOT NULL,
  reg_number text NOT NULL UNIQUE,
  qualifications text[] NOT NULL DEFAULT '{}',
  specialities text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  years_experience int,
  service_area_zone_ids uuid[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','suspended')),
  rating_avg numeric(3,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_bios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  text text NOT NULL CHECK (char_length(text) <= 500),
  moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending','approved','rejected')),
  moderated_by uuid REFERENCES users(id),
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON provider_bios (provider_id, created_at DESC);

CREATE TABLE provider_documents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  kind text NOT NULL CHECK (kind IN ('registration_certificate','id_proof','training_certificate','other')),
  blob_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_sessions (
  provider_id uuid PRIMARY KEY REFERENCES providers(id),
  on_duty boolean NOT NULL DEFAULT false,
  duty_started_at timestamptz,
  location_consent_at timestamptz,
  last_location geography(Point, 4326),
  last_location_at timestamptz,
  active_job_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Partitioned by day; partitions older than 30 days are dropped by a job.
CREATE TABLE location_pings (
  id uuid NOT NULL DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL,
  job_id uuid,
  point geography(Point, 4326) NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE OR REPLACE FUNCTION ensure_location_ping_partitions(days_ahead int DEFAULT 3) RETURNS void AS $$
DECLARE d date; name text;
BEGIN
  FOR i IN -1..days_ahead LOOP
    d := (now() AT TIME ZONE 'UTC')::date + i;
    name := 'location_pings_' || to_char(d, 'YYYYMMDD');
    IF to_regclass(name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF location_pings FOR VALUES FROM (%L) TO (%L)',
                     name, d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
      EXECUTE format('CREATE INDEX ON %I (provider_id, recorded_at)', name);
    END IF;
  END LOOP;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION drop_old_location_ping_partitions(retain_days int DEFAULT 30) RETURNS int AS $$
DECLARE r record; cutoff date := (now() AT TIME ZONE 'UTC')::date - retain_days; dropped int := 0;
BEGIN
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'location_pings'
           AND c.relname ~ '^location_pings_[0-9]{8}$' LOOP
    IF to_date(substring(r.relname FROM 16), 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname); dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$ LANGUAGE plpgsql;

SELECT ensure_location_ping_partitions(3);

-- ───────────────────────────── Consents and terms ─────────────────────────────
CREATE TABLE consent_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  key text NOT NULL,
  version int NOT NULL,
  text jsonb NOT NULL,                 -- { en, ta, kn, hi }
  required boolean NOT NULL,
  service_codes text[],                -- null = all services
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE provider_terms (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  role text NOT NULL,
  version int NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, version)
);

CREATE TABLE provider_terms_acceptances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  role text NOT NULL,
  version int NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  device text,
  ip inet,
  UNIQUE (provider_id, role, version)
);

-- ───────────────────────────── Catalogue ─────────────────────────────
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('visit','emergency','lab','equipment','ambulance','medicine')),
  description text,
  promised_window_minutes int,
  emergency boolean NOT NULL DEFAULT false,
  live_map_allowed boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_options (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  service_id uuid NOT NULL REFERENCES services(id),
  code text NOT NULL,
  name text NOT NULL,
  price_paise int NOT NULL CHECK (price_paise >= 0),
  unit text NOT NULL DEFAULT 'each',
  payee_role text,                     -- provider role paid for this line, null = platform / partner
  payout_rule jsonb NOT NULL DEFAULT '{"type":"percent_fee","fee_bps":2000}',
  meta jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, code)
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users(id),
  service_code text NOT NULL,
  options jsonb NOT NULL,
  line_items jsonb NOT NULL,
  total_paise int NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Uploads ─────────────────────────────
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('prescription_photo','wound_photo','report','provider_document')),
  blob_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Service requests ─────────────────────────────
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid NOT NULL REFERENCES patients(id),
  booked_by_user_id uuid NOT NULL REFERENCES users(id),
  service_code text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  address_id uuid REFERENCES addresses(id),
  symptoms_enc text,
  note_enc text,
  quote_id uuid REFERENCES quotes(id),
  line_items jsonb NOT NULL DEFAULT '[]',
  total_paise int NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  first_dose_mode text CHECK (first_dose_mode IN ('with_doctor','safe_team','at_hospital')),
  emergency boolean NOT NULL DEFAULT false,
  prescription_id uuid,
  eta_minutes int,
  expected_by timestamptz,
  scheduled_for timestamptz,
  cancellation_fee_paise int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft','requested','reviewing','assigning','confirmed','provider_arrived','in_progress','completed',
                    'cancelled_by_patient','cancelled_by_provider','no_provider','failed'))
);
CREATE INDEX ON service_requests (patient_id, created_at DESC);
CREATE INDEX ON service_requests (booked_by_user_id, created_at DESC);
CREATE INDEX ON service_requests (status);

CREATE TABLE request_slots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  role text NOT NULL,
  role_in_visit text NOT NULL CHECK (role_in_visit IN ('lead','assist','remote_supervisor')),
  remote boolean NOT NULL DEFAULT false,
  filled_by_provider_id uuid REFERENCES providers(id),
  UNIQUE (request_id, role, role_in_visit)
);

CREATE TABLE request_assignments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  slot_id uuid NOT NULL REFERENCES request_slots(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  role_in_visit text NOT NULL CHECK (role_in_visit IN ('lead','assist','remote_supervisor')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  outcome text NOT NULL DEFAULT 'offered' CHECK (outcome IN ('offered','accepted','declined','expired','withdrawn','cancelled')),
  decline_reason text,
  eta_minutes int,
  distance_m int,
  assigned_by text NOT NULL DEFAULT 'engine' CHECK (assigned_by IN ('engine','ops')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- DB-level guarantee that only one provider can hold a slot.
CREATE UNIQUE INDEX request_assignments_one_winner ON request_assignments (slot_id) WHERE outcome = 'accepted';
CREATE INDEX ON request_assignments (provider_id, outcome);

CREATE TABLE request_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON request_events (request_id, created_at);
CREATE TRIGGER request_events_append_only BEFORE UPDATE OR DELETE ON request_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE visit_codes (
  request_id uuid PRIMARY KEY REFERENCES service_requests(id),
  code_hash text NOT NULL,
  code_enc text NOT NULL,              -- patient needs to read it back; encrypted
  attempts int NOT NULL DEFAULT 0,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_attachments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  kind text NOT NULL CHECK (kind IN ('prescription_photo','wound_photo','report')),
  blob_key text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE video_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  purpose text NOT NULL CHECK (purpose IN ('first_dose_monitoring','specialist_consult','video_consult')),
  room_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  provider_joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid NOT NULL REFERENCES patients(id),
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid REFERENCES service_requests(id),
  template_key text NOT NULL,
  version int NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  device text,
  ip inet,
  FOREIGN KEY (template_key, version) REFERENCES consent_templates(key, version)
);
CREATE INDEX ON consents (patient_id);
CREATE INDEX ON consents (request_id);

-- ───────────────────────────── Clinical ─────────────────────────────
CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  vitals_enc text,
  notes_enc text,
  diagnosis_enc text,
  advice_enc text,
  restricted boolean NOT NULL DEFAULT false,      -- e.g. psychiatry: notes visible to the author consultant only
  follow_up_at timestamptz,
  follow_up_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON consultations (patient_id, created_at DESC);

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  consultation_id uuid NOT NULL REFERENCES consultations(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  prescriber_id uuid NOT NULL REFERENCES providers(id),
  version int NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES prescriptions(id),
  mode text NOT NULL CHECK (mode IN ('typed','photo')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','superseded')),
  signed_at timestamptz,
  pdf_key text,
  transcription_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prescriptions_single_successor ON prescriptions (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- Signed prescriptions are immutable. The only permitted changes after signing are
-- signed→superseded and attaching the generated PDF / transcription confirmation once.
CREATE OR REPLACE FUNCTION guard_prescription_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.consultation_id <> OLD.consultation_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.prescriber_id <> OLD.prescriber_id OR NEW.version <> OLD.version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.mode <> OLD.mode
     OR NEW.signed_at IS DISTINCT FROM OLD.signed_at THEN
    RAISE EXCEPTION 'PRESCRIPTION_LOCKED: signed prescription % cannot be edited', OLD.id;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'signed' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'PRESCRIPTION_LOCKED: invalid status change % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.pdf_key IS NOT NULL AND NEW.pdf_key IS DISTINCT FROM OLD.pdf_key THEN
    RAISE EXCEPTION 'PRESCRIPTION_LOCKED: pdf already generated';
  END IF;
  IF OLD.transcription_confirmed_at IS NOT NULL AND NEW.transcription_confirmed_at IS DISTINCT FROM OLD.transcription_confirmed_at THEN
    RAISE EXCEPTION 'PRESCRIPTION_LOCKED: transcription already confirmed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescriptions_guard BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION guard_prescription_update();
CREATE OR REPLACE FUNCTION forbid_prescription_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'PRESCRIPTION_LOCKED: prescriptions are never deleted'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescriptions_no_delete BEFORE DELETE ON prescriptions FOR EACH ROW EXECUTE FUNCTION forbid_prescription_delete();

CREATE TABLE prescription_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  prescription_id uuid NOT NULL REFERENCES prescriptions(id),
  position int NOT NULL,
  drug text NOT NULL,
  strength text,
  pattern text,                        -- e.g. 1-0-1
  days int,
  timing text,                         -- before_food | after_food | bedtime ...
  sos boolean NOT NULL DEFAULT false,
  instructions text,
  source text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','transcribed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION guard_prescription_items() RETURNS trigger AS $$
DECLARE st text; pid uuid := COALESCE(NEW.prescription_id, OLD.prescription_id);
BEGIN
  SELECT status INTO st FROM prescriptions WHERE id = pid;
  IF st <> 'draft' THEN RAISE EXCEPTION 'PRESCRIPTION_LOCKED: items of % are locked', pid; END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_items_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION guard_prescription_items();

CREATE TABLE prescription_photos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  prescription_id uuid NOT NULL REFERENCES prescriptions(id),
  page_no int NOT NULL CHECK (page_no BETWEEN 1 AND 5),
  blob_key text NOT NULL,
  quality_status text NOT NULL DEFAULT 'pending' CHECK (quality_status IN ('pending','ok','rejected')),
  quality_reason text,
  ocr_text_enc text,
  pharmacist_transcribed_items jsonb,
  transcribed_by uuid REFERENCES users(id),
  transcribed_at timestamptz,
  provider_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prescription_id, page_no)
);

CREATE TABLE clinical_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  kind text NOT NULL CHECK (kind IN ('drug_condition','drug_allergy','drug_drug')),
  drug_pattern text NOT NULL,          -- case-insensitive regex on drug name
  match_value text NOT NULL,           -- condition / allergy keyword / other drug regex
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  message text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE clinical_alerts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  prescription_id uuid NOT NULL REFERENCES prescriptions(id),
  rule_id uuid REFERENCES clinical_rules(id),
  severity text NOT NULL,
  message text NOT NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Partners ─────────────────────────────
CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  kind text NOT NULL CHECK (kind IN ('pharmacy','lab','equipment','ambulance')),
  name text NOT NULL,
  licence_no text NOT NULL UNIQUE,
  phone_e164 text,
  service_area_zone_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_members (
  partner_id uuid NOT NULL REFERENCES partners(id),
  user_id uuid NOT NULL REFERENCES users(id),
  member_role text NOT NULL DEFAULT 'staff' CHECK (member_role IN ('staff','pharmacist','crew','manager')),
  PRIMARY KEY (partner_id, user_id)
);

-- ───────────────────────────── Lab ─────────────────────────────
CREATE TABLE lab_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  lab_partner_id uuid REFERENCES partners(id),
  tests text[] NOT NULL,
  fasting_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','collected','processing','reported','cancelled')),
  collected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lab_results (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  lab_order_id uuid NOT NULL REFERENCES lab_orders(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  values_enc text NOT NULL,            -- encrypted [{test, analyte, value, unit, ref_low, ref_high, flag}]
  report_key text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Commerce ─────────────────────────────
CREATE TABLE medicines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  strength text,
  form text,
  schedule text NOT NULL DEFAULT 'OTC' CHECK (schedule IN ('OTC','H','H1','X')),
  mrp_paise int NOT NULL CHECK (mrp_paise >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pharmacy_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid NOT NULL REFERENCES patients(id),
  booked_by_user_id uuid NOT NULL REFERENCES users(id),
  address_id uuid NOT NULL REFERENCES addresses(id),
  pharmacy_partner_id uuid REFERENCES partners(id),
  prescription_id uuid REFERENCES prescriptions(id),
  status text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','pending_verification','verified','packed','out_for_delivery','delivered','cancelled','rejected')),
  requires_rx boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  total_paise int NOT NULL,
  courier_location geography(Point, 4326),
  courier_location_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pharmacy_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  order_id uuid NOT NULL REFERENCES pharmacy_orders(id),
  medicine_id uuid NOT NULL REFERENCES medicines(id),
  name text NOT NULL,
  schedule text NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  unit_price_paise int NOT NULL,
  line_total_paise int NOT NULL
);

CREATE TABLE equipment_rentals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid NOT NULL REFERENCES patients(id),
  booked_by_user_id uuid NOT NULL REFERENCES users(id),
  address_id uuid NOT NULL REFERENCES addresses(id),
  item text NOT NULL,
  rate_type text NOT NULL CHECK (rate_type IN ('day','month')),
  quantity int NOT NULL CHECK (quantity > 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  rate_paise int NOT NULL,
  total_paise int NOT NULL,
  supplier_id uuid REFERENCES partners(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','delivered','active','returned','cancelled')),
  end_reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'hospital',
  location geography(Point, 4326) NOT NULL,
  phone_e164 text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ambulance_vehicles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  registration_no text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('normal','oxygen','ventilator')),
  crew_user_id uuid REFERENCES users(id),
  available boolean NOT NULL DEFAULT true,
  location geography(Point, 4326),
  location_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ambulance_vehicles USING gist (location);

CREATE TABLE ambulance_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  patient_id uuid REFERENCES patients(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('normal','oxygen','ventilator')),
  pickup geography(Point, 4326) NOT NULL,
  pickup_address_id uuid REFERENCES addresses(id),
  vehicle_id uuid REFERENCES ambulance_vehicles(id),
  per_km_rate_paise int NOT NULL,
  km numeric(8,2),
  estimated_km numeric(8,2),
  total_paise int,
  destination_facility_id uuid REFERENCES facilities(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','dispatched','acknowledged','arrived','transporting','completed','cancelled','unassigned')),
  acknowledged_at timestamptz,
  ops_paged_at timestamptz,
  escalated_to_108 boolean NOT NULL DEFAULT false,
  payment_status text NOT NULL DEFAULT 'not_attempted',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('service_request','pharmacy_order','equipment_rental','ambulance_run')),
  target_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('upi','card','cash')),
  amount_paise int NOT NULL CHECK (amount_paise >= 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','captured','failed','refunded','partially_refunded')),
  gateway text,
  gateway_order_id text,
  gateway_payment_id text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_gateway_order ON payments (gateway, gateway_order_id) WHERE gateway_order_id IS NOT NULL;
CREATE INDEX ON payments (target_type, target_id);

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  gateway text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_id)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount_paise int NOT NULL CHECK (amount_paise > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  gateway_refund_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE invoice_number_seq;
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  number text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  line_items jsonb NOT NULL,
  total_paise int NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id)
);

CREATE TABLE payout_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  option_code text NOT NULL,
  gross_paise int NOT NULL,
  platform_fee_paise int NOT NULL,
  net_paise int NOT NULL,
  payout_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, request_id, option_code)
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  gross_paise int NOT NULL,
  platform_fee_paise int NOT NULL,
  net_paise int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, period_start, period_end)
);

-- ───────────────────────────── Platform ─────────────────────────────
CREATE TABLE idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response_status int,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route, key)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every read (and denied attempt) of a clinical record.
CREATE TABLE record_access_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  actor_user_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied')),
  reason text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON record_access_log (patient_id, created_at DESC);
CREATE TRIGGER record_access_log_append_only BEFORE UPDATE OR DELETE ON record_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users(id),
  event text NOT NULL,
  language text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push','sms','whatsapp','voice')),
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_blocks (
  key text PRIMARY KEY,
  audience text NOT NULL CHECK (audience IN ('patient','provider','all')),
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','devices','service_zones','patients','family_links','addresses','providers','provider_bios',
    'services','service_options','service_requests','consultations','prescriptions','lab_orders','medicines','pharmacy_orders',
    'equipment_rentals','ambulance_vehicles','ambulance_runs','payments','refunds','partners'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;
