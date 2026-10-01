-- Double-booking protection, rescheduling, PDF receipts and refund retries.

-- How long each visit takes, so overlapping bookings can be detected.
ALTER TABLE visit_occurrences ADD COLUMN duration_minutes int NOT NULL DEFAULT 90 CHECK (duration_minutes > 0);
ALTER TABLE visit_occurrences ADD COLUMN rescheduled_from timestamptz;

-- Time window a visit blocks out. Visits "as soon as possible" block from booking time.
CREATE OR REPLACE FUNCTION occurrence_window(scheduled_for timestamptz, created_at timestamptz, duration_minutes int)
RETURNS tstzrange AS $$
  SELECT tstzrange(COALESCE(scheduled_for, created_at), COALESCE(scheduled_for, created_at) + make_interval(mins => duration_minutes), '[)')
$$ LANGUAGE sql IMMUTABLE;

-- Backfill realistic durations for existing elder-care shifts (day 7 h, night 10 h).
UPDATE visit_occurrences o SET duration_minutes = CASE WHEN sr.options->>'shift' = 'night' THEN 600 ELSE 420 END
FROM service_requests sr WHERE sr.id = o.request_id AND sr.service_code = 'elder_care';

-- PDF receipt generated on first download.
ALTER TABLE invoices ADD COLUMN pdf_key text;

-- Failed refunds are retried automatically; ops is alerted when retries run out.
ALTER TABLE refunds ADD COLUMN attempts int NOT NULL DEFAULT 1;
ALTER TABLE refunds ADD COLUMN last_error text;
ALTER TABLE refunds ADD COLUMN next_retry_at timestamptz;
ALTER TABLE refunds ADD COLUMN gave_up_at timestamptz;
UPDATE refunds SET next_retry_at = now() WHERE status = 'failed';
