# Audit Evidence and Open Items

Updated **2026-11-15** against verified application commit `f21af8e`.

## Closed Implementation & Verification Items (Phases 1–5)

1. **Self-hosted provider wiring (`87e76d9`):** Closed previous gap where self-hosted helpers existed without provider integration; `resolveMailProvider` now instantiates `SelfHostedMailProvider` with unit tests (`self-hosted-provider.test.ts`).
2. **Incremental IMAP sync, worker wiring & health check (`7bb42f3`):** Implemented `syncSelfHostedAccount`, `parseSafeModSeq`, multi-attribute cross-folder move tracking, pre-rule IMAP lock release, worker queue/maintenance scheduling (`provider-sync.ts`, `provider-maintenance.ts`), `/api/health` folder probe, and loopback TLS/Dovecot harness tests (`self-hosted-sync.test.ts`, `self-hosted-dovecot.test.ts`).
3. **Closed-signup password auth & invite lifecycle (`91f64b6`):** Added `MailboxInvitation`, `disableSignUp: true` on Better Auth `emailAndPassword` (`session-auth.ts`), SHA-256 invite tokens, `/api/auth/invite`, CLI `invite:create`, password rotation, and real `auth.api.signUpEmail`/`signInEmail` tests (`self-hosted-invitations.test.ts`).
4. **Audited manual SMTP outbox (`8598361`):** Added `OutboundMessageDelivery` (`CLAIMED`/`PRE_DATA`/`IN_DATA`/`UNCERTAIN`), enforced `PILOT_MODE` + `userInitiated === true` + ownership/sender/CRLF validation, implicit TLS / mandatory `STARTTLS`, `UNCERTAIN` `\Sent` reconciliation, and loopback SMTP/STARTTLS tests (`self-hosted-smtp.test.ts`).
5. **Reproducible migrations, DR drill & preflight (`f21af8e`):** Added baseline SQL migration (`20261115000000_production_baseline`), switched `docker-compose.yml` from `prisma db push` to `prisma migrate deploy`, and verified `verify-backup-restore.ts` + `verify-mailserver-preflight.ts` in `backup-restore.test.ts`.

## Open Live-Environment Items (Not Local Code Gaps)

| Item | Reason Open Locally | Evidence Required on Staging/Prod |
|---|---|---|
| Native `pg_dump` / `pg_restore` binary execution | Host lacks PostgreSQL client binaries (`@embedded-postgres` provides `initdb`/`pg_ctl`/`postgres` only); local drill verified `logical_snapshot` + SHA-256 + `tar` path | Run `verify-backup-restore.ts` on target host with `pg_dump` on `PATH` |
| Live Dovecot/Postfix TLS & SMTP/IMAP handshake | No live VPS/mailserver provisioned from this workspace | Set `DOVECOT_TEST_HOST` and execute preflight + integration tests |
| Live Redis queue integration | `REDIS_TEST_BINARY` unset locally | Run `stage5-redis-integration.test.ts` against Redis |
| Public DNS & reverse PTR verification | No cloud DNS zone or Elastic IP provisioned | Execute `verify-mailserver-preflight.ts` against live domain |
