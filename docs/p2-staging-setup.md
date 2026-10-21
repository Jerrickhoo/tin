# Finish P2: your setup and Codex's remaining work

P3 follow-up: migration 008 is now installed on staging and production, and current clients use `tin-ledger/2`. See [P3 verification](p3-verification.md). The original P2 setup record below remains useful for reproducing the isolated environment.

**Completed 2026-10-21:** the user supplied `tin-p2-staging` and authenticated the CLI. P2's migration, backend, backup/restore and real service-worker offline/reconnect/conflict gates passed. See [completion evidence](p2-staging-verification.md). The steps below are retained for reproduction; no further user setup is needed for P2.

## What you need to do

Use a separate Supabase cloud project. No Docker installation is needed for this route.

1. Open [Supabase projects](https://supabase.com/dashboard/projects) and sign in.
2. Create a **New project** named **tin-p2-staging**. Choose your organization, a database password, and region. Keep the password in your password manager; it does not need to be shared in chat. Wait for the database to be ready.
3. Look at the dashboard address: `https://supabase.com/dashboard/project/abcdefghijklmnopqrst`. Copy the 20-character project reference after `/project/`.
4. Open the already-created `.env.p2-staging.local` in this repository. Fill only the first value and save:

   ```dotenv
   P2_STAGING_PROJECT_REF=abcdefghijklmnopqrst
   P2_STAGING_DISPOSABLE=true
   ```

   Replace the example reference with your actual **staging** reference. This file is ignored by Git. It contains no API keys and does not configure Vite or replace the daily `.env`.

5. Open PowerShell and run:

   ```powershell
   Set-Location 'C:\Codes\Finance App'
   npx.cmd --yes supabase@2.111.0 login
   ```

   Complete the browser sign-in/verification prompted by the CLI. This authenticates the account; it does not migrate or deploy anything. If the CLI asks for a personal access token, use the account's token page linked by the CLI and enter it in your terminal. Do not paste it into chat.

6. Tell Codex **"Staging is ready."** Codex can then run the preflight and the remaining checks. You do not need to run migrations or tests yourself.

If you already have an empty disposable project, identify it clearly as `tin-p2-staging` and use its reference. The preflight requires a name identifying it as P2 staging. No production project is a substitute.

## Prepared locally

`npm run p2:staging:check` reads only the dedicated staging configuration, verifies the reference differs from the daily project's known references, checks account access, and executes a read-only schema query through the Management API. It uses its own temporary project directory and never changes the repository's existing Supabase link. It emits no API keys or credentialed response bodies. It does not apply a migration or write ledger data.

`npm run p2:staging:guard-test` verifies refusal of the daily project, missing protection context, malformed references and targets not explicitly declared disposable.

The installed/cached Supabase CLI 2.111.0 supports `db query --linked` through the Management API. Once logged in, Codex can perform SQL setup without requiring you to supply a database password or install a local database. If your account lacks the required project permissions, the preflight will stop and identify access as unresolved.

## What Codex will do after access is available

1. Verify the selected project and prepare disposable users and a synthetic legacy-account fixture.
2. Rehearse migrations 001–007 with legacy rows present before 007; inspect grants and refresh the PostgREST schema cache.
3. Test the actual gateway header, authenticated owner access, anonymous/foreign-owner denial, old-client rejection, replay, rollback, concurrent corrections/settlements and reconciliation audit.
4. Export/restore the linked fixture into a second staging account and compare entries, financial links, obligations and audit.
5. Build the app against staging on its own local origin and verify the real service worker, offline save/reload/reconnect, queue draining, conflict recovery and week-preference sync.
6. Fix any failures and record exact evidence. Close P2 only when its gates pass.

All steps above have now completed on isolated staging. The preflight's temporary CLI link supplies an IPv4 pooler cache required by the CLI before linked Management API queries. The existing daily link was not changed. No production migration or deployment was performed.

## References checked on 2026-10-21

- [Supabase project creation guide](https://supabase.com/docs/guides/getting-started/tutorials/with-react#project-setup)
- [Supabase CLI login and credential storage](https://supabase.com/docs/reference/cli/supabase-login)
- [Supabase CLI source: database query command](https://github.com/supabase/cli)
