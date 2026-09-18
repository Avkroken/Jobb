# Dashboard and monthly automation

`jobb` supports two execution modes that use the same idempotent application pipeline.

## Manual mode

The protected dashboard exposes **Kör nu** only during the active application window, the **1st–14th** of each calendar month in `Europe/Stockholm`. Outside that window the UI disables the action and the API rejects manual runs.

The button starts a Cloudflare Workflow and immediately returns control to the browser. Progress, failures, completed applications, and BankID handoff state are persisted in D1 and displayed by the dashboard.

## Automatic safety mode

The low-traffic fallback runs **once per day on the 10th–13th**. Cloudflare Cron invokes the Worker at `09:00 UTC`, which is 10:00 CET or 11:00 CEST, safely inside the requested **10:00–20:00 Europe/Stockholm** window.

The 10th is the normal autonomous attempt. The 11th–13th are retries only when the stable monthly run (`scheduled:YYYY-MM`) is still `failed`. Completed, running, or BankID-waiting monthly runs are not restarted. There is no autonomous job-search traffic on the 14th or the 15th–end of month.

A scheduled run:

1. Counts already verified applications for the current calendar month.
2. Applies only to configured suitable StudentConsulting jobs.
3. Uses exactly ten D1 quota slots for the month; an 11th automatic submission cannot acquire a slot.
4. Never counts an application as verified until the exact StudentConsulting Jobb-ID is visible in `Ansökningar`.
5. During the 1st–14th reporting window, prepares the previous calendar month's activity report and starts the user-controlled BankID handoff.
6. Sends a notification when BankID is required.

## Exact monthly quota

`migrations/0004_monthly_application_quota.sql` creates ten slots for each month. A slot is reserved **before** StudentConsulting submission starts.

- A definitely failed submission releases its reservation.
- A confirmed submission keeps its slot.
- A verified submission marks its slot verified.
- An ambiguous/unknown result keeps the slot as `uncertain` rather than allowing a replacement application that could accidentally become number 11.

This is deliberately fail-closed: the automation will never knowingly submit more than ten jobs in a calendar month. If an external site leaves the result ambiguous, the dashboard reports the problem and blocks additional submissions until it is resolved.

## Error diagnostics

Application attempts persist a machine-readable `error_code` plus the provider's error message. The dashboard renders the failure stage and reason, for example:

- `APPLICATION_FAILED` — StudentConsulting rejected or failed the application.
- `APPLICATION_UNKNOWN` — submission outcome could not be determined safely.
- `VERIFICATION_FAILED` — submission was reported, but the exact Jobb-ID was not found in `Ansökningar`.
- `UNEXPECTED_APPLICATION_ERROR` — browser/provider automation raised an unexpected error.

Run-level and Arbetsförmedlingen probe errors are also persisted and shown separately.

## Required runtime secrets/configuration

Secrets should be configured in Cloudflare, never committed to the public repository.

```text
DASHBOARD_USERNAME
DASHBOARD_PASSWORD
STUDENTCONSULTING_EMAIL
STUDENTCONSULTING_PASSWORD
```

Autonomous application submission additionally requires:

```text
STUDENTCONSULTING_AUTOSUBMIT=true
JOB_INCLUDE_TERMS=supporttekniker,it-support,helpdesk
```

Optional suitability constraints:

```text
JOB_EXCLUDE_TERMS=chef,senior
JOB_ALLOWED_LOCATIONS=Stockholm,Uppsala
JOB_ALLOWED_COUNTRIES=SE
```

The application engine fails closed when `JOB_INCLUDE_TERMS` is missing. This prevents a fresh public deployment from applying indiscriminately.

## BankID notifications

Email notifications use the Cloudflare `EMAIL` binding plus:

```text
NOTIFY_EMAIL_TO=user@example.com
NOTIFY_EMAIL_FROM=jobb@example.com
PUBLIC_BASE_URL=https://jobb.example.com
```

An optional generic HTTPS webhook can be configured with:

```text
NOTIFY_WEBHOOK_URL=https://example.com/hooks/bankid
```

The notification links to the protected dashboard. It does not expose the ephemeral Browser Run Live View URL outside the authenticated dashboard.

## BankID and authenticated form discovery

The application can start and retain an Arbetsförmedlingen browser session and display the BankID handoff in the dashboard. The user must personally complete the BankID/e-identification step.

While a handoff is active, the dashboard polls the authenticated session. After BankID succeeds, a fail-closed integration probe navigates to the activity report and stores its **form schema**, not the user's entered values. The probe records items such as headings, input/select/button names, control types, list options and sanitized link paths. It never reads or stores input values.

The probe exists because the authenticated activity-report form is not publicly documented as a write API. The report adapter uses semantic labels/roles and the verified probe instead of guessing private endpoints.

After a successful BankID login, the adapter loads exactly ten verified applications from the previous month. It validates the application dates in Europe/Stockholm, includes the StudentConsulting Jobb-ID together with the employer name, resolves occupations through JobTech Taxonomy, marks international applications as outside Sweden, and fills Swedish locations through the structured location control.

Each activity is idempotent: D1 persists `pending → save_attempted → saved` before/after the external Save side effect. If Save returns an ambiguous result, the next pass first checks whether the exact Jobb-ID is already present and never blindly clicks Save again. The final report submission uses the same rule: `reports.status='submitting'` is persisted before the external submit click; later retries verify confirmation instead of resubmitting.

Since June 2026, Arbetsförmedlingen can also require answers to activities transferred from the user's handlingsplan. The automation does **not** invent those answers. Any unresolved required question leaves the Browser Run session available in the dashboard for the user; after the user answers, polling resumes the same report flow.

## D1 migrations

Apply migrations in order:

```text
migrations/0001_initial.sql
migrations/0002_automation.sql
migrations/0003_integration_probes.sql
migrations/0004_monthly_application_quota.sql
migrations/0005_activity_report_submission.sql
```

`0002_automation.sql` adds workflow/run state, notification history, BankID handoff metadata, and links applications to their automation run.

`0003_integration_probes.sql` stores metadata for sanitized authenticated integration probes. Full probe documents are kept in the private R2 evidence bucket.

`0004_monthly_application_quota.sql` enforces the ten-slot monthly submission ceiling.


`0005_activity_report_submission.sql` tracks idempotent Arbetsförmedlingen activity-item saves so browser/network ambiguity cannot cause duplicate reporting actions.


## Cloudflare deployment

Production deployment uses **Cloudflare Workers Builds with the GitHub integration**, not GitHub Actions credentials.

GitHub does not require `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`.

Recommended Workers Builds settings:

```text
Git repository: Avkroken/Jobb
Production branch: main
Root directory: /
Build command: pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
Deploy command: pnpm deploy:cloudflare
```

The production deploy command applies D1 migrations first and then runs Wrangler deploy. Cloudflare authenticates the build through its own Git integration.

The Worker configuration publishes the custom domain `jobb.denied.se` and binds Browser Run, D1, R2, Email, Workflow and Cron resources.
