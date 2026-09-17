# Authentication and credentials

## StudentConsulting

StudentConsulting credentials are runtime secrets, never repository configuration.

Required secret names:

- `STUDENTCONSULTING_EMAIL`
- `STUDENTCONSULTING_PASSWORD`

Production deployments should store these as Cloudflare Worker secrets. Local development may use `.dev.vars`, which must remain gitignored.

The application code receives credentials through an adapter-level `CredentialsProvider`; it must not log, persist to D1/R2, return through API responses, or include credentials in screenshots/evidence.

GitHub Actions secrets may be used by deployment workflows, but application runtime credentials should preferably be provisioned directly as Cloudflare secrets rather than passed through ordinary repository variables.

## Arbetsförmedlingen / e-identification

E-identification is user-controlled. The application may initiate an authentication session and wait for the user to complete the BankID/e-identification step. It must not store BankID credentials, attempt to automate signing, or treat an authentication request as completed until the remote service confirms the authenticated session.

After successful user authentication, an ephemeral authenticated browser/session may continue the permitted workflow. Session material must be treated as sensitive and must not be written to logs or the public repository.

## Public-repository rule

Only secret *names*, interfaces, examples with dummy values, and setup instructions belong in Git. Real credentials never do.
