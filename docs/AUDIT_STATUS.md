# Audit evidence and open items

This is an evidence map for [ANTIGRAVITY_AUDIT_CHECKLIST.md](../ANTIGRAVITY_AUDIT_CHECKLIST.md), not a claim that the complete audit has passed. The checklist itself skips numbers 15, 16, 28, 49 and 50.

| Checks | Current evidence and limits |
| --- | --- |
| 1 | The tracked license is the requested MIT text. |
| 2–6 | The project commands have passed locally; see [STATUS.md](../STATUS.md). The clean Linux install initially exposed outdated pnpm build approvals; after correcting them, the Docker image built and its PostgreSQL, Redis, web and worker services started successfully in an isolated smoke test. Live providers were not used. |
| 7–8 | `.env.example` is a template with no populated credentials. A redacted Gitleaks scan of the committed history found no leaks, and a targeted common-token scan of the browser bundle found no matches. These tools cannot prove the absence of every possible secret. Recheck the final commit and tracked files. |
| 9 | The optimistic client is tested for immediate updates and rollback. A local 1,000-iteration timing sample measured maximum synchronous update times of 0.370 ms for archive, 1.745 ms for label, and 0.276 ms for mark-read; this is a local sample, not a performance guarantee. |
| 10–14 | Sanitizer, Unicode truncation, emulator operations and authenticated encryption have automated tests under `apps/web/__tests__/`. |
| 17–20, 22–27 | The stage-two routing, group exclusion, correction, safety, AI-routing and execution tests cover these behaviors, with check 19 limited to deterministic-only groups; hybrid AND rules follow the later requirement described below. The tests are not a substitute for live provider verification. |
| 21 | Two consistent AI classifications create an AI_LEARNED group item, but a hybrid group + natural-language AND rule continues to invoke AI. This follows the user's later explicit requirement and conflicts with the checklist's unconditional third-message bypass. |
| 29–35 | Prompt-injection, spoof, protected-sender, unsubscribe validation and health tests exist; the offline evaluation also records zero adversarial outbound sends for its synthetic cases. |
| 36 | The limiter and retry headers are tested; an independent HTTP burst against each named production endpoint has not been completed. |
| 37 | A temporary clone was mutated to disable the static-From guard; the targeted integration test failed, then passed after the guard was restored. The entire `pnpm test` command was not run with the mutation. |
| 38–40 | Reply state, cleanup, DKIM-verified unsubscribe and digest have local PostgreSQL and simulated-provider tests. Live mail delivery has not been tested. |
| 41–45 | The fresh-clone demo was inspected at 1280×900 and 375×812; inbox navigation, J and command-menu keys, rules, newsletter stats, analytics, a visible keyboard focus outline, no mobile horizontal overflow, and no new console errors were observed. J, K, E, R and command-menu shortcuts were checked in the disposable demo; R was corrected after it inserted a character into the draft. Group badges, all newsletter actions, and the full accessibility audit remain unverified. |
| 46 | All six MCP tools are exercised against the seeded emulator in the local database integration test; real-provider MCP behavior is simulated. |
| 47 | `pnpm eval` runs 60 synthetic cases in an isolated temporary database. The recorded run has zero VIP archives and zero sends. Results use the deterministic emulator and do not measure unseen mail or live models. |
| 48 | A clean clone of commit `78de0c5` installed from a warm offline cache and opened both seeded demo accounts without mail or model credentials, including with install scripts disabled. |

The supported local demo and its tests do not establish that the application is ready for production use. Provider setup, live mailbox sync, history recovery, and trusted client IP handling retain limitations described in [STATUS.md](../STATUS.md).
