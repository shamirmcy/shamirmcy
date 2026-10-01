-- OTP delivery channel (WhatsApp first, SMS fallback).
ALTER TABLE otp_challenges ADD COLUMN channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('whatsapp','sms'));
ALTER TABLE otp_challenges ADD COLUMN provider_message_id text;
-- Encrypted copy of the code, kept only until the challenge is used or expires, so a WhatsApp
-- delivery failure reported later by webhook can resend the same code by SMS.
ALTER TABLE otp_challenges ADD COLUMN code_enc text;
ALTER TABLE otp_challenges ADD COLUMN fallback_sent_at timestamptz;
CREATE INDEX ON otp_challenges (provider_message_id) WHERE provider_message_id IS NOT NULL;
