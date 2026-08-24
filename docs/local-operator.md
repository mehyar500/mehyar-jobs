# Local job-pipeline operator

The browser UI and D1 database remain on Cloudflare. This script runs from a local computer and uses the same authenticated API, so the remote UI stays the single source of truth.

Set credentials only in the local user environment. Either provide a short-lived `MEHYAR_JOBS_TOKEN`, or set `MEHYARSOFT_ADMIN_USERNAME` and `MEHYARSOFT_ADMIN_PASSWORD`.

```powershell
$env:MEHYARSOFT_ADMIN_USERNAME = "your-admin-username"
$env:MEHYARSOFT_ADMIN_PASSWORD = "your-admin-password"
npm run local:pipeline -- status
npm run local:pipeline -- score
npm run local:pipeline -- queue 70 10
npm run local:daily-auto-apply -- --fit-min 70 --target 10
```

`status` is read-only. `score` recomputes fit scores remotely using the stored profile. `queue` adds application candidates and creates linked draft applications. `local:daily-auto-apply` fills the queue up to the remaining daily target, writes private material JSON from the remote draft, and runs the local Playwright submitter for supported Greenhouse and Ashby jobs.

For a Windows scheduled task, run `npm run local:daily-auto-apply -- --fit-min 70 --target 10` from a script that reads credentials from a user-scoped secret store. Do not put credentials in the task command line, repository, or a checked-in `.env` file. The local submitter stops and records `needs_user_action` for CAPTCHA, verification, unsupported ATSs, missing resume fields, and absent confirmation screens instead of treating them as submitted.
# Local Operator

The job tracker is remote, but scraping and form work run on the local computer.

## Local Greenhouse application review

```powershell
npm run local:apply -- --job-url "https://job-boards.greenhouse.io/mercury/jobs/5850044004" --material private/materials/mercury-ai-engineering.json --mode review
```

The runner uses the ignored `private/mehyar-swelim-application-profile.md`, attaches the original resume file, and uses application material authored by Codex in this task. It fills supported Greenhouse fields and writes the exact input audit to `private/runs/`. It does not fill voluntary EEO data. A remote tracker sync is optional and only occurs when a tracker application id and token are supplied.

After reviewing the browser and remote record, a deliberate submission requires the exact application id:

```powershell
npm run local:apply -- --job-url "https://job-boards.greenhouse.io/mercury/jobs/5850044004" --material private/materials/mercury-ai-engineering.json --mode submit --confirm APPLY
```

CAPTCHA, unknown ATSs, missing resume fields, and absent confirmation screens stop the run and are reported as `needs_user_action` instead of being treated as submitted.

## Cloudflare daily discovery

`mehyar-jobs-scanner` runs every 15 minutes and advances one bounded D1-backed batch until the current UTC day's scan is complete. The first batch synchronizes the source directory and refreshes U.S./worldwide contractor jobs from Himalayas. Inspect it without changing state:

```powershell
curl.exe https://mehyar-jobs-scanner.mehyar.workers.dev
npx wrangler d1 execute mehyar-jobs --remote --command "SELECT * FROM scan_scheduler_state"
```

Deploy the scheduler after the normal Pages deploy:

```powershell
npm run deploy
npm run deploy:scanner
```
