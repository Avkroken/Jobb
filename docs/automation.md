# Dashboard and monthly automation

`jobb` supports two execution modes that use the same idempotent application pipeline.

## Manual mode

The protected dashboard exposes **Kör nu**. It starts a Cloudflare Workflow and immediately returns control to the browser. Progress, failures, completed applications, and BankID handoff state are persisted in D1 and displayed by the dashboard.

## Automatic safety mode

Cloudflare Cron invokes the Worker hourly on the 14th using a broad UTC interval. The Worker then validates the time against `Europe/Stockholm` and only starts an automation run between **10:00 and 20:00 local time**.

The scheduled D1 run key is stable for the month (`scheduled:YYYY-MM`). This makes repeated Cron invocations converge on the same monthly run rather than creating a new logical run each hour.

A scheduled run:

1. Counts already verified applications for the current calendar month.
2. Applies only to configured suitable StudentConsulting jobs until the monthly target of 10 is reached.
3. Never counts an application until the exact StudentConsulting Jobb-ID is verified in `Ansökningar`.
4. During the 1st–14th reporting window, prepares the previous calendar month's activity report and starts the user-controlled BankID handoff.
5. Sends a notification when BankID is required.

Applications made on the 14th belong to the current month. They are **not** backdated into the previous month's activity report. If the previous month does not already contain the required verified applications, the report is marked failed for manual review instead of fabricating activity dates.

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

## BankID boundary

The application can start and retain an Arbetsförmedlingen browser session and display the BankID handoff in the dashboard. The user must personally complete the BankID/e-identification step.

The authenticated Arbetsförmedlingen activity-report form adapter is intentionally not guessed. Until that adapter has been verified against the real authenticated form, the pipeline stops after confirming that the BankID session is authenticated. This is the remaining integration step before end-to-end automatic report submission can be enabled.

## D1 migrations

Apply both migrations in order:

```text
migrations/0001_initial.sql
migrations/0002_automation.sql
```

`0002_automation.sql` adds workflow/run state, notification history, BankID handoff metadata, and links applications to their automation run.
