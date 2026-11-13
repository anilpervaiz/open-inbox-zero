# Capability and stage map

Snapshot: 2026-11-13. “Implemented” means code is present; it does not imply the full audit checklist, live service integration, or production readiness.

| Capability | Current state | Evidence / limitation |
| --- | --- | --- |
| Local demo | Implemented | Two synthetic emulator accounts; embedded PostgreSQL and no paid LLM key needed. [Launcher](../apps/web/scripts/local-dev.ts) and [seed data](../apps/web/scripts/seed-data.ts). |
| Inbox and thread view | Implemented locally | Split inbox, account switcher, virtualized list, message view, draft saving and navigation in [workspace.tsx](../apps/web/app/components/workspace.tsx). Connected-account support has simulated tests; live provider verification is outstanding. |
| Rules and knowledge | Implemented locally | Rule creation/editing, sender groups and knowledge management. A rule correction undoes the old action, records feedback, and attempts a separately audited replacement execution subject to safety guards. |
| Rule routing and learning | Implemented locally | System/static/group checks, cold gate, AI selection/fallback, separate draft generation and learned-group feedback. See [matcher](../apps/web/utils/ai/choose-rule/match-rules.ts). |
| Cleanup, unsubscribe, cold handling | Implemented locally | Cleanup jobs, undo, unsubscribe, cold sender handling and local API/UI. Real-provider requests and sign-in are not proven end to end. |
| Reply tracking and digest | Implemented locally | Tracker state, label outbox and structured digest exist. Live provider event ingestion and full account workflows remain to be integrated and verified. |
| Gmail / Microsoft adapters | Implemented, mocked tests | Live OAuth, token refresh, webhook delivery and live-account behavior remain unverified. |
| Browser SQLite cache | Partial | [mail-sqlite](../packages/mail-sqlite/src/index.ts) provides an account-scoped FTS5 cache, with OPFS where supported; the workspace does not yet use it. |
| Shared mail UI and CLI | Partial | [mail-ui](../packages/mail-ui/src/index.ts) supplies sanitization and display helpers. [cli](../packages/cli/src/index.ts) dispatches commands; evaluation invokes the Stage 6 runner and local API commands require the emulator token. The current UI lives in the web application. |
| Real-account auth, public API security and MCP | Partial | Key and session authentication support owned emulator and connected provider accounts; live provider verification remains outstanding. |
| 60-message evaluation | Implemented locally | `pnpm eval` runs synthetic cases with the deterministic emulator and records a report; it does not establish live-provider or unseen-mail performance. |
| Deployment and release | Partial | Docker Compose, CI, and release docs are present; An isolated Docker build and startup smoke test passed and history/bundle scans found no matches; hosted CI, live-provider and fresh-clone verification remain outstanding. |

## Ordered next work

1. Finish **Stage 5**: account authentication and authorization, provider credentials and background execution, API hardening and live-provider verification, including MCP tools and health checks. Preserve the local emulator path and add tests for account isolation and abuse cases.
2. Address the remaining architecture gaps: browser cache/shared packages, CLI and the production queue choice, or document and explicitly approve any deviation from the original target.
3. Review and extend **Stage 6** evaluation with broader cases and live-provider validation where credentials are available; current results are limited to synthetic offline fixtures.
4. Complete **Stage 7** packaging, deployment documentation, CI and security checks.
5. Execute the [audit checklist](../ANTIGRAVITY_AUDIT_CHECKLIST.md), investigate failures, and record evidence rather than marking an item complete from implementation alone.

Each stage is expected to pass `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` before its stage commit, as specified in the [build plan](../CODEX_BUILD_PLAN.md).

Stage 5 progress: `/api/health` provides free liveness and authenticated database, configured Redis, local emulator and up to ten connected provider checks; more than ten providers are reported as partial. Live provider verification remains outstanding. Local API burst limits are process-local; MCP uses Redis-backed limiting outside local mode; trusted client-IP identification remains outstanding.

The user API-key model stores only a hash and supports expiration and owner-scoped revocation. The six MCP tools use these keys for owned emulator and connected provider accounts. Signed-in users can create and revoke assistant keys in the workspace; live-provider MCP verification remains outstanding; configured Better Auth sessions can also authenticate MCP.

The delayed worker can resolve real Gmail and Outlook accounts using encrypted, refreshable credentials. This has not been tested against live providers; OAuth sign-in and incoming-message synchronization remain incomplete.

Google Pub/Sub and Microsoft Graph webhook handlers verify notification credentials and enqueue BullMQ synchronization work. Gmail requires an initialized history cursor, and Microsoft requires a registered subscription with a stored client-state hash; initial watch/subscription setup is implemented when the required public settings are configured, but automatic renewal is not implemented. Provider notifications have mock tests; queue delivery and deduplication were tested with isolated Redis 7.4.12, and cursor recovery was tested with local PostgreSQL. Live provider delivery remains unverified. Microsoft folder removals preserve cached messages outside the inbox.

Better Auth provides configurable Google/Microsoft identity sign-in and signed sessions, with encrypted OAuth-token storage and implicit account linking disabled. A session-authenticated endpoint can link an identity to its verified mailbox after checking permissions. The sign-in/connection screen and a paginated initial sync are implemented. The import is tested with simulated providers; live provider verification and expired-history recovery remain incomplete.

The worker renews Gmail watches and active Microsoft subscriptions before expiration. Gmail catch-up is queued without advancing the stored history cursor. Provider responses are simulated in tests; expired subscriptions and expired Gmail history require recovery, and live renewal has not been verified.

The cleanup and digest APIs accept signed-in sessions with mailbox-owner checks; local demo tokens remain limited to emulator accounts. Real-provider cleanup is tested with simulated provider responses, not live mailboxes.
