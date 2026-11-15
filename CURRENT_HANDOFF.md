# Current Handoff

Snapshot updated **2026-11-15** after completing and verifying the 5-phase self-hosted email implementation plan on branch `main` (code baseline [`f21af8e`](apps/web/prisma/migrations/20261115000000_production_baseline/migration.sql) — full verification completed before this documentation refresh).

## Completed Baseline & Commit History

The self-hosted IMAP/SMTP stack, closed-signup invitation auth, manual SMTP outbox, and operational readiness tooling are now implemented and integrated on `main`:

| Phase / Scope | Commit | Key Modules & Behavior |
|---|---|---|
| Self-hosted IMAP foundation | `b804da6`, `29c0dc1`, `9cad6f5` | Bounded raw MIME parser, IMAP session helpers, folder identity & message reads |
| Phase 1 — Provider & resolver | `87e76d9` | [`SelfHostedMailProvider`](apps/web/utils/mail-provider/self-hosted-provider.ts), [`resolveMailProvider`](apps/web/utils/mail-provider/provider-resolver.ts), pass-through helpers, [`self-hosted-provider.test.ts`](apps/web/__tests__/self-hosted-provider.test.ts) |
| Phase 2 — Sync, queue, health & TLS | `7bb42f3` | [`syncSelfHostedAccount`](apps/web/utils/worker/self-hosted-sync.ts) (bootstrap without rules, incremental `UIDVALIDITY`/multi-attribute move reconciliation), worker/queue/maintenance scheduling ([`provider-sync.ts`](apps/web/utils/worker/provider-sync.ts), [`provider-maintenance.ts`](apps/web/utils/worker/provider-maintenance.ts)), [`/api/health`](apps/web/app/api/health/route.ts) folder probe, loopback TLS/Dovecot harness tests |
| Phase 3 — Closed-signup auth & invites | `91f64b6` | `MailboxInvitation` model, closed-signup Better Auth `emailAndPassword` (`disableSignUp: true` in [`session-auth.ts`](apps/web/utils/auth/session-auth.ts)), [`invitations.ts`](apps/web/utils/auth/invitations.ts), [`/api/auth/invite`](apps/web/app/api/auth/invite/route.ts), CLI `invite:create` (`apps/web/scripts/invite-create.ts`), password rotation |
| Phase 4 — Audited manual SMTP outbox | `8598361` | `OutboundMessageDelivery` model, [`self-hosted-smtp.ts`](apps/web/utils/mail-provider/self-hosted-smtp.ts) (`sendSelfHostedSmtpMessage`, `reconcileUncertainOutboundDelivery`) preserving `PILOT_MODE`, CRLF/sender/ownership checks, implicit TLS & `STARTTLS`, `CLAIMED`/`PRE_DATA`/`IN_DATA`/`UNCERTAIN` recovery |
| Phase 5 — Migration, DR & preflight | `f21af8e` | Baseline migration [`20261115000000_production_baseline`](apps/web/prisma/migrations/20261115000000_production_baseline/migration.sql), [`docker-compose.yml`](docker-compose.yml) `prisma migrate deploy`, [`verify-backup-restore.ts`](apps/web/scripts/verify-backup-restore.ts), [`verify-mailserver-preflight.ts`](apps/web/scripts/verify-mailserver-preflight.ts), [`backup-restore.test.ts`](apps/web/__tests__/backup-restore.test.ts) |

## Verified Checks (on `f21af8e`)

- `pnpm test --force` — **6/6** workspace packages passed; `@open-inbox-zero/web` ran **51 passed | 1 skipped (52)** test files and **227 passed | 2 skipped (229)** tests (skipped: gated live `REDIS_TEST_BINARY` in [`stage5-redis-integration.test.ts`](apps/web/__tests__/stage5-redis-integration.test.ts) and gated live `DOVECOT_TEST_HOST` in [`self-hosted-dovecot.test.ts`](apps/web/__tests__/self-hosted-dovecot.test.ts)).
- `turbo run lint --force` — **6/6** packages passed (`0 cached`).
- `pnpm typecheck` — **6/6** packages passed (`tsc --noEmit`).
- `pnpm build` — **6/6** packages passed (`next build --webpack` built all app & API routes including `/api/auth/invite` and `/api/health`).
- `pnpm eval` — **60/60** deterministic synthetic cases passed (`ruleAccuracy: 100%`, `coldEmailPrecision: 100%`, `unsubscribeSafety: 100%`, `vipFalseArchiveRate: 0%`, `replyStateAccuracy: 100%`, `unauthorizedSendRate: 0%`, `learnedGroupHitRate: 100%`; all 6 gates `true`, `generatedAt: 2026-11-15T16:22:37.712Z` in [`eval-report.json`](apps/web/data/eval-report.json)).

## Honest Limits & Deferred Live Cutover Items

- **Local harnesses vs. live servers:** IMAP, STARTTLS, SMTP, migration, invitation, and preflight tests verified code paths using embedded PostgreSQL (`embedded-postgres`), local Node `tls.createServer`/`net.createServer` loopback harnesses, and injected/mocked DNS/TLS/SMTP probes.
- **Backup/restore drill mode locally:** Because `pg_dump`/`pg_restore` binaries are absent on this macOS host, the automated test drill executed `verify-backup-restore.ts` in `logical_snapshot` + SHA-256 + `/usr/bin/tar` Maildir restore mode; the `pg_dump`/`pg_restore` path in [`verify-backup-restore.ts`](apps/web/scripts/verify-backup-restore.ts) remains for PostgreSQL client environments.
- **Deferred operator steps (intentionally not executed here):** Provisioning Oracle Cloud / VPS hosts, configuring DNS records (A/AAAA/MX/PTR/SPF/DKIM/DMARC), running [`verify-mailserver-preflight.ts`](apps/web/scripts/verify-mailserver-preflight.ts) against a live mail domain, running live `DOVECOT_TEST_HOST` or `REDIS_TEST_BINARY` suites, and connecting live Gmail/Outlook OAuth accounts.
- **Safety & workspace hygiene:** `PILOT_MODE=true` blocks automated AI/rule sends and forwards by default. Local demo (`pnpm local:start`) and [`deploy/mailserver/compose.yaml`](deploy/mailserver/compose.yaml) are OFF. Pre-existing modification in `apps/web/next-env.d.ts` was left untouched and uncommitted.

## Next Operator / Production Cutover Steps

1. On target host with `pg_dump`/`pg_restore` installed, run `verify-backup-restore.ts` to verify native binary dump/restore in addition to the local `logical_snapshot` drill.
2. Provision mailserver host and DNS (`deploy/mailserver/README.md`), then run `pnpm --filter @open-inbox-zero/web exec tsx scripts/verify-mailserver-preflight.ts --domain <domain> --mailHost <mailHost>`.
3. Verify live worker/IMAP/SMTP integration by setting `DOVECOT_TEST_HOST` and `REDIS_TEST_BINARY` in an isolated staging environment and re-running the test suite.
4. Issue the first admin mailbox invitation via `pnpm cli invite:create` or [`/api/auth/invite`](apps/web/app/api/auth/invite/route.ts) before onboarding live mailboxes.

See also: [Status](STATUS.md) · [Documentation Index](docs/README.md) · [Verification & Handoff](docs/VERIFICATION_AND_HANDOFF.md) · [Audit Status](docs/AUDIT_STATUS.md)
