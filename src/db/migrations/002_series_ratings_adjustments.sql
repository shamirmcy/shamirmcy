-- Series visits, ratings, provider cancellations and estimate true-up.

-- Every service request has one or more visit occurrences. Single visits have one; dressing
-- series (×5 / ×7) and elder-care shifts (day / week / month) have several, all held by the
-- same assigned provider for continuity of care.
CREATE TABLE visit_occurrences (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  seq int NOT NULL CHECK (seq >= 1),
  scheduled_for timestamptz,                 -- null = as soon as possible
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','missed','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES providers(id),
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, seq)
);
CREATE INDEX ON visit_occurrences (status, scheduled_for);
CREATE TRIGGER visit_occurrences_touch BEFORE UPDATE ON visit_occurrences FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Backfill: existing requests get a single occurrence that mirrors their state.
INSERT INTO visit_occurrences (request_id, seq, scheduled_for, status, completed_at)
SELECT id, 1, scheduled_for,
       CASE WHEN status = 'completed' THEN 'completed'
            WHEN status IN ('cancelled_by_patient','cancelled_by_provider','no_provider','failed') THEN 'cancelled'
            WHEN status IN ('provider_arrived','in_progress') THEN 'in_progress'
            ELSE 'scheduled' END,
       CASE WHEN status = 'completed' THEN updated_at END
FROM service_requests;

-- What the patient finally pays after series completion / cancellation and estimate true-up.
ALTER TABLE service_requests ADD COLUMN final_total_paise int;
ALTER TABLE service_requests ADD COLUMN settled_at timestamptz;

-- Actual cost of an estimated line (kit "up to ₹600", materials "~₹120"). Never above the quote.
CREATE TABLE request_adjustments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  option_code text NOT NULL,
  quoted_paise int NOT NULL,
  actual_paise int NOT NULL CHECK (actual_paise >= 0),
  note text,
  recorded_by uuid NOT NULL REFERENCES providers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, option_code),
  CHECK (actual_paise <= quoted_paise)
);
CREATE TRIGGER request_adjustments_touch BEFORE UPDATE ON request_adjustments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Refunds raised by the system (settlement) have no ops author.
ALTER TABLE refunds ADD COLUMN source text NOT NULL DEFAULT 'ops' CHECK (source IN ('ops','settlement'));

-- Patient ratings of the professionals on a completed visit. One per provider per request.
CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  rated_by_user_id uuid NOT NULL REFERENCES users(id),
  stars int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment text CHECK (char_length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, provider_id)
);
ALTER TABLE providers ADD COLUMN rating_count int NOT NULL DEFAULT 0;

-- Provider-initiated cancellations (the request is re-assigned, not ended).
CREATE TABLE provider_cancellations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON provider_cancellations (provider_id, created_at DESC);

-- Estimated lines (charged as quoted, trued-up to actual cost after the visit).
UPDATE service_options o SET meta = o.meta || '{"estimate": true}'
FROM services s WHERE s.id = o.service_id
  AND ((s.code = 'iv_care' AND o.code IN ('kit_drip','kit_antibiotic')) OR (s.code = 'wound_dressing' AND o.code = 'materials'));
