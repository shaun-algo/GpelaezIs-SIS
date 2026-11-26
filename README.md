# DepEd Capstone System

Source-only repository for the DepEd school information and academic monitoring system.

## Included

- PHP API endpoints and authentication flows
- Static HTML dashboards and management pages
- CSS, JavaScript, vendor assets, and report templates used by the application
- Configuration examples, schema-only database setup, and migrations

Private credentials, local configuration, database exports, learner/staff records, test fixtures, deployment archives, and research files are intentionally excluded.

## Requirements

- Apache with PHP 8.1 or newer
- MySQL or MariaDB with PDO MySQL enabled
- Composer only if email-based recovery is enabled

## Local setup

1. Serve this directory from Apache.
2. Copy `api/database/config.local.php.example` to `api/database/config.local.php` and set the local database values.
3. Import `schema/export_july10.3.sql` into an empty database, then apply the required files in `api/database/migrations/` for the selected feature set.
4. Copy `api/auth/email_otp/config.local.php.example` to `api/auth/email_otp/config.local.php` only when email OTP recovery is needed.
5. Install the optional mail dependency with `composer install --working-dir=api/mail --no-dev`.

No default account or production database is included. Create administrator credentials in the private database setup used by the deployment.

## Configuration

The application reads database settings from environment variables when available, otherwise from the ignored `config.local.php` file. Never commit real passwords, SMTP credentials, learner data, or staff data.
