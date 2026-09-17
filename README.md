# jobb

Open-source job application automation for StudentConsulting with Cloudflare Workers, D1, R2, Browser Run and Workflows.

The project targets **10 verified suitable applications per calendar month** and keeps an auditable record of successful applications, failures and supporting evidence. Arbetsförmedlingen reporting uses a user-controlled BankID handoff; BankID signing itself is never automated.

## Execution modes

- **Manual** — start the application pipeline from the protected dashboard.
- **Automatic safety run** — on the 14th, between 10:00 and 20:00 `Europe/Stockholm`, the system ensures the current month's application target and prepares the previous month's activity report.

The application engine is fail-closed: autonomous StudentConsulting submission requires explicit suitability rules and `STUDENTCONSULTING_AUTOSUBMIT=true`.

See [`docs/automation.md`](docs/automation.md) for scheduling, runtime configuration, notifications and the BankID/reporting boundary.
