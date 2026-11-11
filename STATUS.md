# Open Inbox Zero — Current Status

Last updated: 2026-11-11

For the detailed documentation index, see [docs/README.md](docs/README.md).

The application is **not finished**. This file records the current implementation and known gaps; `ARCHITECTURE.md`, `CODEX_BUILD_PLAN.md`, and `ANTIGRAVITY_AUDIT_CHECKLIST.md` remain the specification and have not been marked as completed audits.

## Implemented so far

- **Stage 0 — Foundation:** Workspace, PostgreSQL schema, token encryption, seeded local accounts and embedded database launcher. Commit `3b78f08`.
- **Stage 1 — Mail engine:** Canonical mail state, optimistic client, emulator, and Gmail/Outlook adapters. Commit `e79584e`.
- **Stage 2 — Rule engine:** Matching funnel, AI routing and local fallback, learned patterns, audited actions, guards, undo and a local delayed-action worker. Commit `eb2882f`.
- **Stage 3 — Cleanup and reply tracking:** Unsubscribe and cleanup services, reply tracker, digest and local emulator API routes. Commit `0669203`.
- **Stage 4 — Local inbox interface:** Split inbox, draft composer, rule and knowledge screens, unsubscribe and cold-email views, analytics, audit log, command menu and keyboard navigation. Commit `cd76041`.

On 2026-11-11, after the rule and shared-package updates, `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed locally. `pnpm eval` is not yet implemented. The desktop preview and a 375-pixel mobile inbox/thread view were inspected; this is not a completed browser audit of every interaction. The test suite uses an embedded PostgreSQL server and simulated provider APIs; it does not establish live Gmail or Outlook behavior.

Start the local seeded demo with `pnpm install` followed by `pnpm local:start`. It uses synthetic email accounts and does not require OAuth credentials or a paid model key. Demo data is not real customer or production data.

## Remaining work

1. **Stage 5:** Public liveness and token-protected database/Redis/emulator health checks are implemented; provider health is explicitly not checked. Set `HEALTH_TOKEN` to enable authenticated checks and `REDIS_URL` to include Redis; neither is needed for public liveness. Local APIs have in-process burst limits, and a Redis-backed limiter is available but not wired to production routes. Complete authenticated account access, trusted client-IP handling, real-provider credential and background-worker integration, API security and the six MCP tools. Current workspace, cleanup and digest API routes are restricted to local emulator accounts. The local delayed worker uses PostgreSQL polling; a production BullMQ/Redis adapter remains outstanding.
2. **Stage 6:** Build and run the specified 60-email evaluation. No benchmark result or safety target has yet been measured.
3. **Stage 7:** Complete Docker and CI packaging, self-hosting and security documentation, secret scanning, and the fresh-clone check.
4. Run the full `ANTIGRAVITY_AUDIT_CHECKLIST.md` and resolve failures. Passing stage checks is not proof that the complete checklist or real-provider workflows pass.

The **Change rule** control now undoes the previous action, records feedback, and attempts an audited replacement execution. Safety guards can prevent or delay actions; interrupted or uncertain provider operations can require operator recovery. Hybrid static/group rules using AND with AI instructions now require both the deterministic match and AI selection. Consequently, learned groups on these hybrid rules do not bypass AI.

The shared packages now contain an SQLite FTS5 message cache, email sanitization and status helpers, and CLI dispatch for seed, rules, digest, and evaluation. These are initial primitives: the web UI is not connected to the SQLite cache or shared components, persistent SQLite requires a supported OPFS worker, and the CLI evaluation command cannot succeed until Stage 6 provides `pnpm eval`. The local API CLI commands require the local emulator token in the environment.
