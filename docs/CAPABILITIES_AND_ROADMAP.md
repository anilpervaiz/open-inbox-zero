# Capabilities and Roadmap

Updated **2026-11-15** against verified application commit `f21af8e`.

## What Is Built & Verified Locally

### Stages 1–4 (Core Demo & Rule Control Plane)

- **Local synthetic demo (`pnpm local:start`):** SQLite-backed synthetic inbox (`@open-inbox-zero/mail-sqlite`) showcasing triage, rules, reply tracking, cold-email blocking, and safe unsubscribe without live OAuth or external AI keys.
- **Rule engine & safety controls:** Hybrid `AND` rule evaluation, prompt-injection safeguards, and `PILOT_MODE=true` gating that prevents automated AI/rule sends and forwards.
- **Deterministic evaluation harness (`pnpm eval`):** 60 synthetic benchmark cases verifying rule accuracy, cold-email precision, unsubscribe safety, VIP protection, reply state tracking, and zero unauthorized sends.

### Self-Hosted Mail Phases 1–5 (Integrated on `main`)

- **Phase 1 (`87e76d9`) — Self-hosted IMAP provider & resolver:** [`SelfHostedMailProvider`](../apps/web/utils/mail-provider/self-hosted-provider.ts) wired into [`resolveMailProvider`](../apps/web/utils/mail-provider/provider-resolver.ts) for `provider === 'selfhosted'`, plus safe pass-through helpers and unit tests.
- **Phase 2 (`7bb42f3`) — Sync, queue, maintenance & health:** [`syncSelfHostedAccount`](../apps/web/utils/worker/self-hosted-sync.ts) supports initial bootstrap without rule execution, incremental `UIDVALIDITY`/`HIGHESTMODSEQ` sync (`parseSafeModSeq`), multi-attribute cross-folder move tracking, and pre-rule IMAP lock cleanup, wired into [`provider-sync.ts`](../apps/web/utils/worker/provider-sync.ts), [`provider-maintenance.ts`](../apps/web/utils/worker/provider-maintenance.ts), and [`/api/health`](../apps/web/app/api/health/route.ts), verified with real Node loopback TLS/IMAP harnesses ([`self-hosted-dovecot.test.ts`](../apps/web/__tests__/self-hosted-dovecot.test.ts)).
- **Phase 3 (`91f64b6`) — Closed-signup password auth & invitations:** `MailboxInvitation` schema, closed-signup Better Auth `emailAndPassword` (`disableSignUp: true` in [`session-auth.ts`](../apps/web/utils/auth/session-auth.ts)), SHA-256 token invite lifecycle & credential rotation ([`invitations.ts`](../apps/web/utils/auth/invitations.ts)), [`/api/auth/invite`](../apps/web/app/api/auth/invite/route.ts), and `@open-inbox-zero/cli` `invite:create` ([`invite-create.ts`](../apps/web/scripts/invite-create.ts)).
- **Phase 4 (`8598361`) — Audited manual SMTP outbox:** `OutboundMessageDelivery` schema and [`self-hosted-smtp.ts`](../apps/web/utils/mail-provider/self-hosted-smtp.ts) enforcing `PILOT_MODE` + explicit `userInitiated === true`, CRLF/sender/ownership checks, implicit TLS / mandatory `STARTTLS`, `CLAIMED`/`PRE_DATA`/`IN_DATA`/`UNCERTAIN` recovery, best-effort `\Sent` append, and [`self-hosted-smtp.test.ts`](../apps/web/__tests__/self-hosted-smtp.test.ts).
- **Phase 5 (`f21af8e`) — Production migration, DR drill & mailserver preflight:** Baseline SQL migration [`20261115000000_production_baseline`](../apps/web/prisma/migrations/20261115000000_production_baseline/migration.sql), [`docker-compose.yml`](../docker-compose.yml) `prisma migrate deploy`, [`verify-backup-restore.ts`](../apps/web/scripts/verify-backup-restore.ts), and [`verify-mailserver-preflight.ts`](../apps/web/scripts/verify-mailserver-preflight.ts) verified in [`backup-restore.test.ts`](../apps/web/__tests__/backup-restore.test.ts).

## What Remains Operator-Deferred (Live Environment Only)

| Area | Current Status | Operator Action Needed for Live Cutover |
|---|---|---|
| Live PostgreSQL `pg_dump` / `pg_restore` | Code path implemented in [`verify-backup-restore.ts`](../apps/web/scripts/verify-backup-restore.ts); macOS test host used `logical_snapshot` + `tar` fallback because `pg_dump` is absent | Run `verify-backup-restore.ts` on a Linux/macOS host with PostgreSQL client binaries installed |
| Live Dovecot / Postfix mailserver | Scaffolding in [`deploy/mailserver/compose.yaml`](../deploy/mailserver/compose.yaml); verified locally with Node loopback TLS/STARTTLS harnesses | Provision VM + certificates, set `DOVECOT_TEST_HOST`, and verify live IMAP/SMTP |
| Public DNS (MX, PTR, SPF, DKIM, DMARC) | Preflight verifier tested with injected probes | Configure registrar/cloud DNS and run [`verify-mailserver-preflight.ts`](../apps/web/scripts/verify-mailserver-preflight.ts) |
| Live Redis integration | Worker queue tests pass; live Redis suite gated by `REDIS_TEST_BINARY` | Run against target Redis instance during staging soak test |
| Live Gmail / Outlook OAuth | Not exercised against live vendor accounts locally | Supply OAuth client credentials during cloud rollout if needed |
