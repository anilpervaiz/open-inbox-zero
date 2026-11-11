# Capability and stage map

Snapshot: 2026-11-11, application commit `cd76041`. “Implemented” means code is present; it does not imply the full audit checklist, live service integration, or production readiness.

| Capability | Current state | Evidence / limitation |
| --- | --- | --- |
| Local demo | Implemented | Two synthetic emulator accounts; embedded PostgreSQL and no paid LLM key needed. [Launcher](../apps/web/scripts/local-dev.ts) and [seed data](../apps/web/scripts/seed-data.ts). |
| Inbox and thread view | Implemented locally | Split inbox, account switcher, virtualized list, message view, draft saving and navigation in [workspace.tsx](../apps/web/app/components/workspace.tsx). Not connected to real-account sign-in. |
| Rules and knowledge | Implemented locally | Rule creation/editing, sender groups and knowledge management. A rule correction records feedback and undoes the old action; it does not run the replacement rule on the same message. |
| Rule routing and learning | Implemented locally | System/static/group checks, cold gate, AI selection/fallback, separate draft generation and learned-group feedback. See [matcher](../apps/web/utils/ai/choose-rule/match-rules.ts). |
| Cleanup, unsubscribe, cold handling | Implemented locally | Cleanup jobs, undo, unsubscribe, cold sender handling and local API/UI. Real-provider requests and sign-in are not proven end to end. |
| Reply tracking and digest | Implemented locally | Tracker state, label outbox and structured digest exist. Live provider event ingestion and full account workflows remain to be integrated and verified. |
| Gmail / Microsoft adapters | Implemented, mocked tests | Live OAuth, token refresh, webhook delivery and live-account behavior remain unverified. |
| Browser SQLite cache | Not implemented | [mail-sqlite](../packages/mail-sqlite/src/index.ts) is an empty scaffold. `mail-core` optimistic state is present but the workspace does not establish the specified browser SQLite architecture. |
| Shared mail UI and CLI | Not implemented | [mail-ui](../packages/mail-ui/src/index.ts) and [cli](../packages/cli/src/index.ts) are empty scaffolds; current UI lives in the web application. |
| Real-account auth, public API security and MCP | Not implemented | Stage 5 remains. Current API routes are for local emulator accounts. |
| 60-message evaluation | Not implemented | No `pnpm eval` script, benchmark report, or measured safety result exists. |
| Deployment and release | Not implemented | Docker Compose, CI workflow, self-hosting docs, full history/bundle secret scan and fresh-clone verification remain Stage 7 work. |

## Ordered next work

1. Finish **Stage 5**: account authentication and authorization, provider credentials and background execution, API hardening, health endpoint, and all six MCP tools. Preserve the local emulator path and add tests for account isolation and abuse cases.
2. Address the remaining architecture gaps: browser cache/shared packages, CLI and the production queue choice, or document and explicitly approve any deviation from the original target.
3. Build and run **Stage 6** evaluation; report measured accuracy, VIP false archives, unauthorized sends and learned-group hits without inventing results.
4. Complete **Stage 7** packaging, deployment documentation, CI and security checks.
5. Execute the [audit checklist](../ANTIGRAVITY_AUDIT_CHECKLIST.md), investigate failures, and record evidence rather than marking an item complete from implementation alone.

Each stage is expected to pass `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` before its stage commit, as specified in the [build plan](../CODEX_BUILD_PLAN.md).
