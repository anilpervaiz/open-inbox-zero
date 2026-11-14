# Current handoff for Antigravity and contributors

Updated: **2026-11-14**. Application baseline reviewed: branch `main`, commit `3aeb5555a9ce256318adce345bbfec11ed67864a`. This is a point-in-time baseline; check `git status`, branch and HEAD before changing anything. No Git remote was configured when checked.

## User goal and boundaries

Build a small open-source email workspace inspired by Inbox Zero, starting with the user's **own self-hosted mail service**. The first live deployment is intended for one domain, administrator-created invited users and direct outbound delivery. Gmail/Outlook integrations remain in the repository but their live rollout is deferred. More reference-product features can be added later; do not treat full feature parity as a prerequisite for the first release.

The user is arranging Oracle Cloud hosting and has said a domain and test accounts are available; no server access, domain details, credentials, deployment or live mail test have been provided in this workspace. Never ask for passwords, private keys or API secrets in chat. Direct delivery on Oracle may require an outbound port 25 exemption and a PTR request; verify the account's actual capabilities before relying on them. Use a separate test domain/subdomain to avoid changing existing mail routing.

**Keep the local demo and experimental mail server off** until the user chooses to test them. Do not deploy, change DNS, create cloud resources or expose services based solely on this handoff. Preserve user data and existing unrelated changes.

## Current implementation

- Local demo, inbox, rule engine, cleanup, reply tracking, MCP and synthetic evaluation exist. The 4-stage matcher honors the later explicit user requirement that static/group plus natural-language instructions with AND must satisfy both stages; an unconditional learned-group bypass conflicts with this and is not the intended hybrid behavior.
- Pilot mode is enabled by default; the application Compose file enforces it for web and worker. It skips rule-driven automatic sending and forwarding, including old delayed jobs. Drafts and supported reversible actions remain. An operator can explicitly opt out in a non-Compose deployment; do not do so for the pilot.
- `deploy/mailserver/compose.yaml` defines a separate experimental Postfix/Dovecot/Rspamd-based stack. Its configuration was validated, but the stack has not been started for real mail or tested for live delivery, open relay, spam handling, backups or restoration.
- `SelfHostedCredential` in the Prisma schema and `apps/web/utils/mail-provider/self-hosted-credentials.ts` provide encrypted owner-scoped mailbox credentials. The helper binds encrypted content to account, owner and mailbox; it is not an invitation or sign-in flow. The added table needs a reviewed production migration. Existing Compose uses `prisma db push`, which is not a production migration process.
- `apps/web/utils/mail-provider/self-hosted-imap.ts` has a reusable verified-TLS connection helper and read-only folder listing using owner-scoped credentials, operator-configured `SELF_HOSTED_IMAP_HOST`, port 993 and optional operator-provided `SELF_HOSTED_TLS_CA_FILE`. Tests simulate the provider. `SelfHostedFolderState` and IMAP location columns reserve database identities with 64-bit UIDs; they do not implement reconciliation. **The helper is not wired into `EmailProvider`, the resolver, worker, API or workspace.** There is no full self-hosted provider, message import/sync, SMTP sending, provisioning, password sign-in or invitations yet. Both schema additions need a reviewed production migration.
- Gmail/Outlook auth, token refresh, webhook and queue code have mock/local-database coverage, not live verification. Recovery from expired Gmail history, expired Outlook subscriptions and interrupted sync locks remains incomplete. Keep these as later work unless the user changes priority.

## Evidence and limits

On 2026-11-14, after the IMAP connection-helper and folder-state foundation: `pnpm test --force` passed with **169 web tests** plus other package tests, including the real Redis integration using a temporary Redis 7.4.12 executable. `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm eval` passed. These results do not test a real IMAP connection or mail-server delivery. Earlier runs on the previous change included an initial failure when the temporary Redis binary had disappeared; it was rebuilt and the rerun passed.

The `apps/web/data/eval-report.json` run on 2026-11-14 used 60 synthetic messages and the deterministic emulator; all recorded gates passed. It does not establish live model/mail performance or successful legitimate unsubscriptions. Previous clean-clone and Docker application smoke tests used earlier commits, and hosted CI was not run. Full audit evidence is in [docs/AUDIT_STATUS.md](docs/AUDIT_STATUS.md).

`apps/web/next-env.d.ts` was already modified when this handoff was written: its imports point to `.next/dev/types/...` rather than the committed `.next/types/...`. Preserve it. Next.js build may rewrite it; save its exact contents before building and restore them afterward. Do not include it in unrelated commits. The generated knowledge graph reports it was built from commit `48bbefc`, before the latest application commit; follow the repository graphify instructions and update it after code changes.

## Next steps

1. Implement the self-hosted IMAP provider behind the existing account-scoped provider interface and resolver. Design persistent mailbox/message/thread identity and reconciliation for folder moves, UIDVALIDITY changes, duplicates and disconnects; do not treat an untrusted Message-ID alone as proof of identity, mark sync complete or silently delete records on an incomplete scan. PostgreSQL `BigInt` is signed: address full unsigned 64-bit mod-sequence values before relying on `highestModSeq`, and convert database BigInts deliberately at JSON boundaries. Add database and protocol tests.
2. Implement synchronization and worker scheduling without replaying already-applied actions. Add actual Dovecot-based isolated integration tests for authentication, mailbox isolation, TLS and interruption/recovery; mock-only tests do not prove protocol behavior.
3. Add administrator-created invitations and password sign-in with no public registration. Secure provisioning and credential rotation; ensure ownership is verified before accessing the existing credential helpers.
4. Add explicit user-initiated SMTP sending and a durable audit/outbox policy for unknown delivery outcomes. Never automatically resend an uncertain send, and preserve the pilot's ban on automatic sending/forwarding. Implement safe draft, folder and undo behavior.
5. Add a reviewed production migration and isolated restore test. Complete deployment guidance and security checks, then use the user-provided Oracle environment only after access and test-domain details are available and the planned changes are concrete.

After each task, follow `AGENTS.md`: preserve unrelated changes, run relevant tests plus `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm build`, update `graphify update .` after code edits, and make a small commit on `main`. Report skipped or blocked checks honestly. See [STATUS.md](STATUS.md), [docs/CURRENT_ARCHITECTURE.md](docs/CURRENT_ARCHITECTURE.md), and the original architecture/build plan for more detail.
