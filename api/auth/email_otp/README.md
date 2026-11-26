# Email OTP recovery

This module adds account-type routing to the shared forgot-password flow. Employees use a six-digit email verification step; learners create an adviser-reviewed recovery request without an email reset link. It is written in vanilla JavaScript and PHP with PDO, MySQL, and PHPMailer SMTP. The verified reset session writes through the project’s central account credential helper and does not automatically sign the user in.

## Setup

1. Back up the database and prepare a disposable clone.
2. Apply the existing account recovery migration first if it has not already been applied:

   `api/database/migrations/add_account_recovery.sql`

3. Import `db_schema.sql` into the clone, run the verification checks, and only then schedule a reviewed production migration with `api/database/migrations/add_email_otp_recovery.sql`.
4. Install PHPMailer in the existing mail directory:

   ```sh
   cd api/mail
   composer require phpmailer/phpmailer
   ```

5. Configure the database and SMTP values in the host environment. The names used by `config.php` are:

   `OTP_DB_HOST`, `OTP_DB_PORT`, `OTP_DB_NAME`, `OTP_DB_USER`, `OTP_DB_PASSWORD`, `OTP_SMTP_HOST`, `OTP_SMTP_PORT`, `OTP_SMTP_ENCRYPTION`, `OTP_SMTP_USERNAME`, `OTP_SMTP_PASSWORD`, `OTP_SMTP_FROM_EMAIL`, `OTP_SMTP_FROM_NAME`, `OTP_CORS_ORIGIN`, and `OTP_PHPMAILER_AUTOLOAD`.

   For a simple private host, edit the fallback values in `config.php`, but do not commit SMTP passwords. Gmail requires an app password, not the normal account password.

   For local Apache testing, copy the example values into `config.local.php` and replace `your-sender@example.com`, `PASTE_YOUR_16_CHARACTER_APP_PASSWORD_HERE`, and `YOUR_PUBLIC_DOMAIN`. This local file is ignored by Git and is loaded automatically by `config.php`.

   `email_logo_url` must be a public HTTPS URL to `assets/img/logo/logo.png`. A localhost path cannot be loaded by an email recipient. The logo is referenced in the HTML only and is not added as a MIME attachment.

6. Set `OTP_CORS_ORIGIN` to one exact frontend origin, for example `https://school.example.edu` or `http://localhost`. Use the origin only, without a page path such as `/deped_capstone2`. The module intentionally never returns `*` for credentialed CORS.
7. Open `email-otp/index.html` through Apache or use the migrated `forgot-password.html` link from the sign-in page. PHP must be served by Apache or another PHP host. Opening HTML with `file://` cannot run the endpoints.

## Flow

- `send-otp.php` validates the username or LRN, routes active learners into adviser review, and resolves active employee usernames to their school-record email. Employee OTP sends enforce a 60-second resend cooldown, generate a `random_int()` six-digit code, and store only `password_hash()` output.
- `verify-otp.php` resolves the same username to its current email, locks the latest row, rejects expired, verified, or exhausted codes, increments `attempt_count` before checking the code, and marks a successful code as verified in the same transaction.
- `reset-password.php` uses a short-lived server session plus CSRF value created after verification. It re-locks the account, rechecks account freshness, applies the shared password policy, updates the central credential source, and clears the recovery session.

## Security notes

Codes expire after 5 minutes, allow 5 checks, and are single-use. A resend creates a new latest row, so an older code cannot be used. Plain OTP values are never written to MySQL, logs, JSON responses, localStorage, or session data. SMTP exceptions are logged only by class name so credentials and codes do not enter application logs.

The UI response for an unknown or ineligible account is generic to reduce account enumeration. Learner recovery is adviser-assisted: no learner email is exposed, no learner OTP is sent, and no reset token exists until an authorized adviser or registrar verifies identity and reauthenticates.

SMTP provider acceptance is not proof that a message reached the inbox. Confirm delivery separately and monitor the mail service without exposing recipient, code, or credential details. The SMTP From address is visible to recipients by design; use a dedicated school or no-reply sender account if you do not want to expose a personal address.
