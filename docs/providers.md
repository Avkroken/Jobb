# Provider implementation

## StudentConsulting

The StudentConsulting provider uses Browser Run through a small browser abstraction.

Implemented flow:

1. Open StudentConsulting's `/signin` entry point.
2. Follow the OIDC redirect to `id.studentconsulting.com`.
3. Fill the configured email/password credentials and submit the login form.
4. Discover jobs from the public job listings.
5. Read Jobb-ID, location and occupational category from each job page.
6. Classify Norway and Denmark using StudentConsulting's country-filtered lists; remaining jobs from the Swedish listing are treated as Sweden.
7. Before submission, stop if any visible required application field is unresolved.
8. Submit only when `STUDENTCONSULTING_AUTOSUBMIT=true` and there is exactly one recognized application submit control.
9. Verify the application through the authenticated `Ansökningar` navigation before it can be treated as confirmed.

Runtime secrets:

- `STUDENTCONSULTING_EMAIL`
- `STUDENTCONSULTING_PASSWORD`
- `STUDENTCONSULTING_AUTOSUBMIT` (`true` enables submission after the form has been validated)

Autosubmit defaults to disabled so a public deployment cannot start submitting applications merely because credentials were configured.

## Arbetsförmedlingen JobSearch

`ArbetsformedlingenJobSearchProvider` uses the public JobSearch `/search` endpoint. It maps the fields needed by the internal job model, including employer, location, occupation/taxonomy concept, application URL and application reference.

JobSearch is treated as a read-only job-ad source. It does not submit job applications or activity reports.

The Worker exposes a read-only endpoint:

`GET /api/jobs/search?q=<query>&limit=<n>&offset=<n>`

## Arbetsförmedlingen authentication handoff

BankID/e-identification remains user-controlled.

`startArbetsformedlingenHandoff()` acquires a reusable Cloudflare Browser Run session, navigates to Mina sidor, follows the public `Logga in` link and creates a Live View URL. The browser connection is then disconnected while the remote session remains alive.

The user performs the e-identification step in Live View. `getArbetsformedlingenHandoffStatus()` reconnects to the same Browser Run session and determines whether the authenticated Mina sidor UI is present.

The Browser Run session ID is sensitive session state. It must be stored server-side (for example in a Workflow/Durable Object/D1 row) and must not be exposed as a long-lived browser credential to public clients.

## Still intentionally unmapped

The authenticated Arbetsförmedlingen activity-report form is not hard-coded yet. Its field structure and submission controls must be observed in a legitimate authenticated user session before automation is added. No private API endpoint is assumed or reverse-engineered from guesses.
