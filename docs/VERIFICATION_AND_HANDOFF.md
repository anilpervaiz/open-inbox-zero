# Verification and handoff

Snapshot prepared 2026-11-11 from application commit `cd76041`. These are recorded point-in-time results, not fresh checks run during creation of this documentation.

## Last recorded Stage 4 checks

| Check | Recorded result and limits |
| --- | --- |
| `pnpm test` | Passed: 127 web tests and 6 mail-core tests were reported. Some other scaffold packages use `--passWithNoTests`; a passing workspace command does not imply those packages have feature tests. |
| `pnpm lint` | Passed. |
| `pnpm typecheck` | Passed after the production build completed. |
| `pnpm build` | Passed for the workspace and produced the Next.js application. |
| Browser preview | Desktop inbox, rules, analytics and command menu inspected. At 375px the inbox/thread view had document width and scroll width of 375px, and a local message action returned successfully. Not every view, keyboard shortcut, or mutation was exercised in a real browser. |
| Providers | Gmail, Outlook and outbound HTTP behavior were tested with mocks; no real mailbox, paid AI model, or live unsubscribe was verified. |
| Audit and evaluation | Full Antigravity audit, benchmark, secret-history/bundle scan and fresh-clone test remain open. |

## Run locally

Prerequisites: Node.js 22+ and pnpm. From the repository root:

```sh
pnpm install
pnpm local:start
```

Open the loopback URL printed by the launcher. The demo is synthetic; do not interpret its mailbox data or simulated unsubscribe as real activity. The launcher runs schema synchronization on `DATABASE_URL` if one is supplied, so point it at a suitable project database. The embedded database persists in ignored `.local-data/` when no external URL is supplied.

To run the stage checks:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

The database integration tests start temporary PostgreSQL instances and need local port binding. Avoid running the Next.js build and typecheck simultaneously: they can contend over generated `.next` types. Build and test checks may take time on a fresh install.

## Recovery and operations

Audited recovery scripts exist for interrupted [rule execution](../apps/web/scripts/recover-execution.ts), [cleanup](../apps/web/scripts/recover-cleanup.ts), and [reply tracking](../apps/web/scripts/recover-tracker.ts). Their interactive flows require operator identity, evidence that the original process has stopped, and confirmation. A timeout may leave an outbound operation's outcome uncertain; do not blindly retry it or assume it failed.

The demo API uses an ephemeral launcher-generated token and is limited to emulator accounts. It should not be exposed as a production authentication mechanism. The local worker polls PostgreSQL and resolves emulator providers only.

## Open decisions and checks

- Decide the target behavior for a static rule that also has natural-language instructions: the implemented zero-LLM early return differs from the more restrictive wording in the original architecture.
- Build real account authentication, authorization, credential refresh, inbound/sent event integration, and real-provider worker resolution before claiming live Gmail/Outlook support.
- Integrate and expand the cache, shared UI and CLI, and implement MCP, evaluation and release components described in the [capability map](CAPABILITIES_AND_ROADMAP.md).
- Repeat applicable tests, browser checks, and the complete audit against the final integrated application. Do not claim the benchmark targets until they have actually been measured.
