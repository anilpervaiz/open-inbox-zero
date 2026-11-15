# Verification and Handoff

Updated **2026-11-15** against verified application commit `f21af8e`.

## Commands & Observed Results (Commit `f21af8e`)

| Command | Scope | Result |
|---|---|---|
| `pnpm test --force` | All 6 workspace packages (`turbo run test --force`) | **6/6 packages passed**; `@open-inbox-zero/web`: **51 passed \| 1 skipped (52)** files, **227 passed \| 2 skipped (229)** tests |
| `turbo run lint --force` | Uncached ESLint across all 6 packages (`0 cached`) | **6/6 packages passed** |
| `pnpm typecheck` | `prisma generate` + `tsc --noEmit` across all 6 packages | **6/6 packages passed** |
| `pnpm build` | `prisma generate` + Next.js webpack production build + package builds | **6/6 packages passed** |
| `pnpm eval` | Deterministic 60-case synthetic rule/safety eval (`eval.ts`) | **60/60** passed (`ruleAccuracy: 100%`, `coldEmailPrecision: 100%`, `unsubscribeSafety: 100%`, `vipFalseArchiveRate: 0%`, `replyStateAccuracy: 100%`, `unauthorizedSendRate: 0%`, `learnedGroupHitRate: 100%`, all 6 gates `true`) |

Skipped tests in `pnpm test --force` are strictly environment-gated live integration checks:
- [`stage5-redis-integration.test.ts`](../apps/web/__tests__/stage5-redis-integration.test.ts) (`REDIS_TEST_BINARY` unset locally)
- Live Dovecot server test inside [`self-hosted-dovecot.test.ts`](../apps/web/__tests__/self-hosted-dovecot.test.ts) (`DOVECOT_TEST_HOST` unset locally; the 5 local loopback TLS/OpenSSL harness tests in that file executed and passed).

## Local Usage & Safety State

- Start synthetic local demo (kept OFF by default): `pnpm local:start`
- Create a self-hosted invite via CLI: `pnpm cli invite:create ...`
- Run backup/restore drill directly: `pnpm --filter @open-inbox-zero/web exec tsx scripts/verify-backup-restore.ts`
- Run mailserver DNS/TLS/relay preflight: `pnpm --filter @open-inbox-zero/web exec tsx scripts/verify-mailserver-preflight.ts --domain <domain> --mailHost <mailHost>`
- Note: `PILOT_MODE=true` blocks automated sends/forwards; local demo and [`deploy/mailserver/compose.yaml`](../deploy/mailserver/compose.yaml) are OFF; pre-existing local change in `apps/web/next-env.d.ts` was left untouched and uncommitted.
