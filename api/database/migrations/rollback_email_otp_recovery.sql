-- Rollback for the email OTP table. Confirm the exact target database first.
DROP TABLE IF EXISTS email_otps;

