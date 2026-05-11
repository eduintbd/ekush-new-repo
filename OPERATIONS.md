# Operations runbook

Companion to `README.md`. Covers what's required to actually run the X-System in production: MFA enforcement, backups, log drains, and monitoring.

## 1. MFA (TOTP, Supabase Auth)

### Implementation

- `src/lib/mfa.ts` — Supabase MFA wrappers + role policy.
- `src/lib/auth.ts` — `requireStaff` / `requireAgent` enforce step-up; `requireAuthenticated` is the no-MFA guard used by `/account/mfa` itself.
- `src/app/account/mfa/` — enrol / list / unenroll factors.
- `src/app/login/mfa/` and `src/app/agent/login/mfa/` — challenge pages after password sign-in.
- Sign-in actions (`src/app/login/actions.ts`, `src/app/agent/login/actions.ts`) check `getAuthenticatorAssuranceLevel()` and redirect to the challenge page when a verified factor exists but the session is at AAL1.

### Role policy

| Role | MFA |
| --- | --- |
| `admin` | **Required** — every page guard redirects to `/account/mfa?reason=required` until a factor is verified. |
| `accountant` | **Required** — same as admin. |
| `auditor` | Optional — read-only; encouraged but not enforced. |
| `selling_agent` | Optional — page guard does step-up only if a factor is already enrolled. |

To change the policy, edit `MFA_REQUIRED_ROLES` in `src/lib/mfa.ts`.

### Supabase project configuration

In the Supabase dashboard (Authentication → Multi-Factor Authentication):
- Enable **TOTP** factor type.
- Set **AAL2** as the assurance level required for sensitive operations if you also want server-side enforcement on PostgREST endpoints (we currently enforce in the app layer only).
- The default MFA factor limit per user is 10; lower to 2 for typical office use.

### Recovery

There is no built-in "remember this device" — every sign-in re-challenges. To recover a locked-out admin:

1. Sign in with another admin → go to `/admin/agents/<userId>` (or Supabase dashboard).
2. In Supabase dashboard → Authentication → Users → select the user → **Delete MFA factors**.
3. User signs in with password only, is bounced to `/account/mfa?reason=required`, and re-enrols.

Recovery codes are not yet implemented — track as a follow-up if needed.

---

## 2. Database backups

### Hosted (Supabase Pro / Team)

Supabase automatically backs up every project on the Pro plan or higher:
- **Daily backups** retained for 7 days (Pro) / 14 days (Team) / 28 days (Enterprise).
- **Point-in-time recovery** available on Team+.

Verify:
```bash
supabase backups list --project-ref <ref>
```

Restore drill (run quarterly — assign in incident response checklist):
1. Pick the most recent backup.
2. `supabase backups restore --project-ref <new-staging-ref> --backup-id <id>` — restore into a fresh staging project.
3. Smoke-test: sign in → /trial-balance loads with expected accounts → /journals shows the most recent batch.
4. Tear down the staging restore.

### Self-hosted Postgres

If running Supabase self-hosted or vanilla Postgres:

```bash
# Daily logical backup, retained 14 days
pg_dump --format=custom --no-owner --no-privileges \
  --file="backups/ekush-erp-$(date +%Y-%m-%d).dump" \
  "$DATABASE_URL"

# WAL archiving for point-in-time recovery — configure in postgresql.conf:
#   archive_mode = on
#   archive_command = 'rsync %p backup-host:/wal/%f'
```

Schedule via systemd-timer or cron, ship dumps to an off-site bucket (S3, R2, Vercel Blob).

### Backup verification

After each backup window, verify the dump restores into a throwaway database:
```bash
createdb ekush_erp_restore_test
pg_restore --dbname ekush_erp_restore_test backups/ekush-erp-$(date +%Y-%m-%d).dump
psql ekush_erp_restore_test -c "SELECT COUNT(*) FROM journals"
dropdb ekush_erp_restore_test
```

The monthly close checklist should include a "restore drill succeeded" tick-box.

---

## 3. Log drains

Vercel application logs default to a 1-hour retention on Hobby and 1-day on Pro. For audit-grade retention (auditors will ask), forward all logs to an external sink.

### Setup

1. Vercel dashboard → Project → Settings → **Log Drains** → Add Drain.
2. Pick a destination:
   - **Datadog** (recommended for query/alerting).
   - **Logtail / Better Stack** (cheaper, full-text search).
   - **Generic HTTPS endpoint** if you have your own ingestion.
3. Stream filter: include `function`, `static`, `external`, `build`, `lambda`. Exclude `_next/static` if cost-sensitive.
4. Retention target: **3 years** to align with BSEC record-keeping requirements.

### What we log

Application code uses `console.log` / `console.error` in server actions and API routes. The structured fields you will want to grep on:

- `journal.create` / `journal.update` — audit trail mirror (the DB `audit_log` table is the source of truth; logs are a redundant copy).
- `agent.approve` / `agent.suspend` / `agent.reinstate` — onboarding lifecycle.
- `commission.run` — quarterly trail job output (emitted at the end of `POST /api/cron/quarterly-trail`).
- `mfa.enrolled` / `mfa.unenroll` / `mfa.verify_fail` — security events emitted by `src/app/account/mfa/actions.ts` and `src/app/login/mfa/actions.ts`.
- `tb.out_of_balance` / `tb.check_failed` — trial-balance integrity (emitted by `POST /api/cron/tb-check`; see §5).

### Health-probe ingestion

`GET /api/health` returns `{ db, auth, at }` and a 200/503 status. Configure your uptime monitor (BetterUptime, Cronitor, Vercel Cron) to hit this every minute. If the log drain stops receiving health logs for >2 minutes, page the on-call.

---

## 4. Monitoring checklist

| Signal | Source | Alert threshold |
| --- | --- | --- |
| DB connectivity | `/api/health` | 2 consecutive failures |
| Auth misconfiguration | `/api/health` (`auth: 'unconfigured'`) | Any occurrence in prod |
| TB out of balance | `tb.out_of_balance` log lines from `/api/cron/tb-check` | Any occurrence |
| Quarterly trail run failed | `commission.run` log lines | Missing for >24h after quarter-end |
| MFA bypass attempts | `mfa.verify_fail` log lines | >5 / user / hour |

---

## 5. Trial-balance integrity cron

`POST /api/cron/tb-check` walks every open `FiscalYear`, runs the trial-balance aggregation, and emits one of two log lines per FY:

- `event: "tb.out_of_balance"` — net debit total ≠ net credit total. Includes `delta`, `netDebit`, `netCredit`, `fiscalYearLabel`. Log drains should match on `event` and page on-call.
- `event: "tb.check_failed"` — the aggregation threw (DB down, schema issue). Includes the error message.

Schedule hourly via Vercel Cron or an external scheduler:

```bash
# Vercel cron-spec or external scheduler
curl -X POST https://<host>/api/cron/tb-check \
     -H "X-Cron-Secret: $CRON_SECRET"
```

Closed fiscal years are skipped — once a year is closed, mutations are blocked at the DB trigger level (`xsystem_journals_fy_closed_guard`), so the TB cannot drift.
