# Open Inbox Zero — Agent Build Rules (For Codex / ChatGPT)

Read `ARCHITECTURE.md` and `CODEX_BUILD_PLAN.md` in this directory before writing any code.

## Mission

Build **Open Inbox Zero**: a 100% truly open-source (**MIT License**) AI email assistant and Superhuman-style split-inbox client built with the exact same architecture, tech stack, and multi-stage rule engine as `inbox-zero`, with zero proprietary or non-commercial license restrictions.

## Core Invariants (Never Violate)

1. **4-Stage Rule Matching Funnel (`findMatchingRules`):**
   Every incoming message must pass through the 4-stage funnel in strict order:
   - **Stage A (System & Thread Heuristics):** Check `isReplyInThread`, `isCalendarInvite`, `NO_REPLY_PREFIXES` (`noreply@`, `newsletter@`, `notifications@`, etc.), and sender reply history (`checkSenderReplyHistory`).
   - **Stage B (Static Conditions & Learned Sender Groups):** Deterministic matching on `from`, `to`, `subject`, `body` glob/regex patterns and `Group` / `GroupItem` lookups (including `GroupItemSource.AI_LEARNED`). If a sender matches a learned group or static rule, resolve in `0ms` with **zero LLM calls**.
   - **Stage C (Cold Email Gate):** If the sender has never emailed the user or been replied to before, evaluate the Cold Email classifier (`isColdEmail`).
   - **Stage D (AI Rule Router — `aiChooseRule`):** Only when deterministic rules do not settle the message, call the LLM via Vercel AI SDK (`generateText` + `Output.object` with a strict Zod schema) using the user's natural-language `Rule.instructions` and `ClassificationFeedback` history. If the model claims a match that does not resolve to an offered `Rule.name`, throw an explicit error rather than silently skipping.

2. **Two-Step AI Separation (`aiChooseRule` -> `getActionItemsWithAiArgs`):**
   - Never ask a single giant prompt to both choose a rule and write an email draft.
   - Step 1 (`aiChooseRule`) selects the matching rule(s) and records `RuleSelectionMetadata`.
   - Step 2 (`getActionItemsWithAiArgs`) runs **only** if a matched rule contains dynamic action arguments (such as `ActionType.DRAFT_EMAIL` or `ActionType.REPLY`), pulling from the user's `Knowledge` snippets and `ReplyMemory` examples.

3. **Safety & Non-Destructive Execution (`executeAct`):**
   - Persist an `ExecutedRule` (`PENDING`) and `ExecutedAction` rows in PostgreSQL **before** calling the mail provider so every automated action is auditable and 1-click reversible (Undo).
   - **Protected sender guard (`shouldSkipAutomatedArchiveForSender`):** Never auto-archive messages from protected domains (such as the user's own organization domain or VIP contacts).
   - **Static `From` spoof guard (`static-from-risk.ts`):** Block outbound sending/forwarding actions (`REPLY`, `SEND_EMAIL`, `FORWARD`) when a rule matched *solely* on an unverified static `From` header without DKIM/SPF or thread history.
   - Default to `DRAFT_EMAIL` (`drafts.create`) rather than `SEND_EMAIL` unless an action explicitly configures auto-send.

4. **Zero-Config Local Emulator First (`pnpm local:start`):**
   - A fresh clone must boot and work end-to-end with **no Google/Microsoft OAuth credentials and no paid LLM key** required, using a built-in seeded Local Mail Provider Emulator (` developer@example.com` and `developer@outlook.test`) and a deterministic fallback/mock LLM adapter when no API key is configured.

5. **Strict Code Quality:**
   - Every stage in `CODEX_BUILD_PLAN.md` requires unit and integration tests (`vitest`) that fail when the feature is broken and pass when fixed.
   - `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` must pass with 0 errors at the end of every stage.
   - Make small, atomic git commits after each task (`feat(stage-N): ...`). Never commit secrets or `.env` files.
