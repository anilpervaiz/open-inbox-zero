# Verification and handoff

Current handoff: [CURRENT_HANDOFF.md](../CURRENT_HANDOFF.md), refreshed 2026-11-14 against application commit `3aeb555`. Results below are point-in-time local evidence, not a production audit.

| Check | Most recent recorded result |
| --- | --- |
| `pnpm test --force` | Passed on 2026-11-14: 168 web tests and the other package tests. The real Redis integration used a temporary Redis 7.4.12 executable via `REDIS_TEST_BINARY`; the test is skipped when that variable is absent. |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed on 2026-11-14 for the IMAP helper change. Build may rewrite `apps/web/next-env.d.ts`; preserve the pre-existing local change. |
| `pnpm eval` | The committed report was generated 2026-11-13 with a deterministic emulator and 60 synthetic messages; it is not a live-model or live-mailbox measurement. It was not rerun for the latest IMAP helper change. |
| Demo | The demo was previously opened on desktop and a 375-pixel viewport, and its local server was subsequently stopped at the user's request. Do not restart it unless the user requests testing. |
| Self-hosted mail | Compose configuration and helper mocks pass; there has been no live server, TLS, IMAP, SMTP, external delivery, open-relay, spam or restore test. |
| Audit and CI | Full checklist and hosted CI have not been verified. Earlier Docker smoke test and scans are historical; see [AUDIT_STATUS.md](AUDIT_STATUS.md). |

For local checks, the suite needs temporary loopback PostgreSQL instances and optionally a Redis executable. Commands are `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm eval` and `pnpm build`; run typecheck and build sequentially because Next.js can rewrite generated files. A previous pair of full runs timed out during long machine pauses; a later awake run passed. Never commit the generated evaluation report or other files blindly without checking changes.

The local demo uses synthetic accounts and data. If the user later requests it, `pnpm install` and `pnpm local:start` start it; the launcher applies schema synchronization to any supplied `DATABASE_URL`, so use only a project-specific database. The current user request is to leave it stopped.

For incident recovery, consult the existing rule, cleanup and reply-tracker recovery scripts and establish whether external side effects occurred before retrying. A failed provider call can have succeeded remotely. The experimental mail-server deployment has not yet had a tested backup or restore.
