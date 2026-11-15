# Current Architecture and Technology

Updated **2026-11-15** (verified on commit `f21af8e`).

## Monorepo Packages

Turbo workspace (`turbo.json`) builds and tests six TypeScript/Node >=22 packages:

- `@open-inbox-zero/web` ([`apps/web`](../apps/web)) — Next.js 16 App Router UI and API routes, Prisma Postgres client (`@prisma/client`), Better Auth session/invitation auth, IMAP/SMTP providers, sync/rule engine, and synthetic eval harness.
- `@open-inbox-zero/worker` ([`apps/worker`](../apps/worker)) — background BullMQ/queue consumer entrypoint driving account sync and maintenance.
- `@open-inbox-zero/mail-core` ([`packages/mail-core`](../packages/mail-core)) — shared provider types and email rule abstractions.
- `@open-inbox-zero/mail-sqlite` ([`packages/mail-sqlite`](../packages/mail-sqlite)) — SQLite synthetic demo persistence used by `pnpm local:start`.
- `@open-inbox-zero/mail-ui` ([`packages/mail-ui`](../packages/mail-ui)) — shared React mailbox UI primitives.
- `@open-inbox-zero/cli` ([`packages/cli`](../packages/cli)) — CLI utilities including `invite:create` for self-hosted admin invitations.

## Implemented Data & Self-Hosted Mail Flow

1. **Authentication & Closed Onboarding:** [`session-auth.ts`](../apps/web/utils/auth/session-auth.ts) enables Better Auth `emailAndPassword` with `disableSignUp: true` when self-hosted mail is configured. [`invitations.ts`](../apps/web/utils/auth/invitations.ts) manages SHA-256 `MailboxInvitation` records, transactional invitation acceptance (`AuthAccount`, `EmailAccount`, encrypted `SelfHostedCredential`, IMAP probe rollback on failure), and credential rotation via [`/api/auth/invite`](../apps/web/app/api/auth/invite/route.ts) and CLI `invite:create`.
2. **Provider Resolution & Read Path:** [`resolveMailProvider`](../apps/web/utils/mail-provider/provider-resolver.ts) selects [`SelfHostedMailProvider`](../apps/web/utils/mail-provider/self-hosted-provider.ts) for `provider === 'selfhosted'` accounts, using [`self-hosted-imap.ts`](../apps/web/utils/mail-provider/self-hosted-imap.ts) with validated `SELF_HOSTED_IMAP_PORT` and strict TLS (`rejectUnauthorized: true`, optional trusted CA).
3. **Bootstrap & Incremental IMAP Sync:** [`syncSelfHostedAccount`](../apps/web/utils/worker/self-hosted-sync.ts) runs first-time bootstrap scans without executing rules, then performs incremental `UIDVALIDITY`/`HIGHESTMODSEQ` sync (`parseSafeModSeq`), multi-attribute move detection across folders (preserving `id`, `messageId`, `threadId`), and closes the IMAP folder lock before running rule evaluation. Scheduled via [`provider-sync.ts`](../apps/web/utils/worker/provider-sync.ts) and [`provider-maintenance.ts`](../apps/web/utils/worker/provider-maintenance.ts); health-probed via [`/api/health`](../apps/web/app/api/health/route.ts).
4. **Safety-Gated Manual SMTP Outbox:** [`self-hosted-smtp.ts`](../apps/web/utils/mail-provider/self-hosted-smtp.ts) enforces `PILOT_MODE`, explicit `userInitiated === true`, account ownership, sender alignment, CRLF header guards, implicit TLS (465) or mandatory `STARTTLS` (587), `OutboundMessageDelivery` idempotency (`CLAIMED`, `PRE_DATA` -> `FAILED`, `IN_DATA` -> `UNCERTAIN`), best-effort `\Sent` append, and `reconcileUncertainOutboundDelivery`.
5. **Database Migrations & Disaster Recovery:** [`20261115000000_production_baseline`](../apps/web/prisma/migrations/20261115000000_production_baseline/migration.sql) and [`docker-compose.yml`](../docker-compose.yml) (`prisma migrate deploy`) provide reproducible PostgreSQL schema initialization. [`verify-backup-restore.ts`](../apps/web/scripts/verify-backup-restore.ts) and [`verify-mailserver-preflight.ts`](../apps/web/scripts/verify-mailserver-preflight.ts) validate DR restore integrity and DNS/TLS/open-relay readiness.

## Differences From Full Target Deployment

- All automated verification to date ran against `embedded-postgres`, local TLS/TCP loopback servers, and deterministic synthetic fixtures rather than a live Dovecot/Postfix server, live Redis instance, or live OAuth accounts.
- [`deploy/mailserver/compose.yaml`](../deploy/mailserver/compose.yaml) provides local container scaffolding but requires operator host, DNS, certificate, and firewall provisioning outside the repository.
