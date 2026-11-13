# Contributing

Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CODEX_BUILD_PLAN.md](CODEX_BUILD_PLAN.md), and [STATUS.md](STATUS.md) before making changes. Use Node.js 22+ and pnpm 11.17.0.

```sh
pnpm install
pnpm local:start
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm build
```

The local launcher uses an embedded PostgreSQL instance and synthetic mail. Tests create isolated temporary PostgreSQL databases. The Redis integration test runs when `REDIS_TEST_BINARY` points to a Redis server executable; without it that test is skipped. `pnpm eval` creates another temporary database and writes a report from synthetic data. Avoid concurrent full test and build runs on resource-constrained machines.

Keep provider operations account-scoped, preserve the audit-before-action and undo guarantees, and add regression coverage for behavior changes. Distinguish simulator and mocked-provider evidence from live-provider verification. Do not commit populated environment files, OAuth tokens, real mailbox contents, or other secrets. Explain any changed setup or recovery behavior in the documentation.
