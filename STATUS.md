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

At the Stage 4 commit, `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. The desktop preview and a 375-pixel mobile inbox/thread view were inspected; this is not a completed browser audit of every interaction. The test suite uses an embedded PostgreSQL server and simulated provider APIs; it does not establish live Gmail or Outlook behavior.

Start the local seeded demo with `pnpm install` followed by `pnpm local:start`. It uses synthetic email accounts and does not require OAuth credentials or a paid model key. Demo data is not real customer or production data.

## Remaining work

1. **Stage 5:** Complete authenticated account access, real-provider credential and background-worker integration, API security and the six MCP tools. Current workspace, cleanup and digest API routes are restricted to local emulator accounts. The local delayed worker uses PostgreSQL polling; a production BullMQ/Redis adapter remains outstanding.
2. **Stage 6:** Build and run the specified 60-email evaluation. No benchmark result or safety target has yet been measured.
3. **Stage 7:** Complete Docker and CI packaging, self-hosting and security documentation, secret scanning, and the fresh-clone check.
4. Run the full `ANTIGRAVITY_AUDIT_CHECKLIST.md` and resolve failures. Passing stage checks is not proof that the complete checklist or real-provider workflows pass.

The **Change rule** control currently records a correction and undoes the previous action; it does not execute the replacement rule on that same message. Recovery from interrupted or uncertain provider operations can require an operator to verify that the original process has stopped before using the recovery commands.
