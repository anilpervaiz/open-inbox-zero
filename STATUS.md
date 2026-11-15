# Project Status

Last updated **2026-11-15** against tested application commit `f21af8e` on `main`.

## Summary

Open Inbox Zero implements the local SQLite synthetic demo, the Postgres + Prisma web/worker control plane, and all five planned phases of self-hosted IMAP/SMTP mailbox support:

- **Stages 1–4 (Core Demo & Rule Control Plane):** Local synthetic SQLite inbox (`pnpm local:start`), deterministic/hybrid `AND` rule engine, prompt-injection firewall, `PILOT_MODE` safety gating, cold-email/unsubscribe workflows, and synthetic 60-case evaluation suite (`pnpm eval`).
- **Phase 1 (`87e76d9`):** `SelfHostedMailProvider` wired into `resolveMailProvider` alongside pass-through message helpers.
- **Phase 2 (`7bb42f3`):** Incremental & bootstrap IMAP sync (`syncSelfHostedAccount`) with `UIDVALIDITY`/multi-attribute move reconciliation, worker/queue/maintenance wiring, `/api/health` self-hosted folder probe, and loopback TLS/Dovecot harness tests.
- **Phase 3 (`91f64b6`):** `MailboxInvitation` model, closed-signup Better Auth `emailAndPassword` (`disableSignUp: true`), `/api/auth/invite`, `invitations.ts` helpers, `@open-inbox-zero/cli` `invite:create`, and credential rotation.
- **Phase 4 (`8598361`):** `OutboundMessageDelivery` model and audited manual SMTP outbox (`self-hosted-smtp.ts`) preserving `PILOT_MODE`, CRLF/sender/ownership checks, implicit TLS / mandatory `STARTTLS`, and `UNCERTAIN` delivery reconciliation.
- **Phase 5 (`f21af8e`):** Initial Prisma SQL baseline migration (`20261115000000_production_baseline`), `docker-compose.yml` updated to `prisma migrate deploy`, end-to-end backup/restore verification script (`verify-backup-restore.ts`), and DNS/TLS/relay preflight checker (`verify-mailserver-preflight.ts`).

## Verification Snapshot (`f21af8e`)

| Check | Outcome | Observed Coverage |
|---|---|---|
| `pnpm test --force` | Pass | 6/6 workspace packages; `@open-inbox-zero/web`: `51 passed \| 1 skipped (52)` files, `227 passed \| 2 skipped (229)` tests |
| `turbo run lint --force` | Pass | 6/6 packages (`eslint .`, uncached) |
| `pnpm typecheck` | Pass | 6/6 packages (`tsc --noEmit`) |
| `pnpm build` | Pass | 6/6 packages (`next build --webpack` + Next route compilation) |
| `pnpm eval` | Pass | `60/60` cases, `100%` rule accuracy & cold precision, `0` VIP false archives, `0` unauthorized sends |

Skipped tests in `pnpm test --force` are two environment-gated live integration tests: `stage5-redis-integration.test.ts` (`REDIS_TEST_BINARY`) and the live server case in `self-hosted-dovecot.test.ts` (`DOVECOT_TEST_HOST`).

## Known Limitations & Boundaries

- **No live server or cloud cutover executed yet:** All self-hosted IMAP, STARTTLS, SMTP, migration, and preflight verifications ran locally against `embedded-postgres`, local TLS/TCP loopback harnesses, and injected DNS/TLS/SMTP probes.
- **Backup drill mode on macOS:** Because `pg_dump`/`pg_restore` binaries are absent on this macOS host, `backup-restore.test.ts` verified the `logical_snapshot` + SHA-256 + `/usr/bin/tar` Maildir restore path; `pg_dump`/`pg_restore` support in [`verify-backup-restore.ts`](apps/web/scripts/verify-backup-restore.ts) should be exercised on a target Postgres host.
- **Live OAuth & Production LLM/Cloud deployment:** Live Gmail/Outlook credentials, Oracle Cloud / VPS provisioning, public DNS records, and live Dovecot/Postfix validation remain outside the verified local test scope.
- **Services OFF:** Synthetic demo (`pnpm local:start`) and experimental mail server (`deploy/mailserver/compose.yaml`) remain stopped.

## Navigation

- [Current Handoff](CURRENT_HANDOFF.md) — commit ledger, verified checks, and operator cutover steps
- [Documentation Index](docs/README.md) — architecture, capability map, verification guide, and audit trail
- [Architecture Specification](ARCHITECTURE.md) · [Codex Build Plan](CODEX_BUILD_PLAN.md) · [Antigravity Audit Checklist](ANTIGRAVITY_AUDIT_CHECKLIST.md)
