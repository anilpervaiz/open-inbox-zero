# How it works

Incoming messages pass through a four-stage matcher. System and thread heuristics run first. Static conditions and sender groups run second; deterministic-only matches bypass the AI router. Unknown senders then pass through the cold-email gate, and remaining candidates go to the AI rule selector. When a rule combines static or group conditions with natural-language instructions using AND, both the deterministic conditions and the AI selection must match.

Rule selection and draft generation are separate. Draft generation can use knowledge and prior examples. The deterministic local adapter works without a model key. Repeated consistent AI classifications can create learned sender-group entries; user corrections record feedback and can remove learned entries. A hybrid AND rule continues to use the AI router even if a group was learned.

Before automated mail changes, the application records the rule execution and actions. Archive guards protect the account's domain and configured VIP patterns; outbound guards restrict actions based solely on an unverified From header. Undo uses provider-specific snapshots and cannot guarantee automatic recovery from every uncertain external outcome.

Pilot mode defaults to blocking rule-driven automatic sends and forwards, including actions scheduled before pilot mode was enabled. This does not yet provide a self-hosted manual-send flow.

Reply tracking replays incoming and sent events in time order. An incoming request can create a needs-reply state, a verified user reply can change it to awaiting-reply, and an appropriate later response can resolve that state. Label changes are recorded and synchronized separately.

Public health is a liveness response. Detailed health checks need a bearer token. Session and API-key access are account-scoped; keys are stored as hashes. Provider webhooks validate their credentials before queueing work. These boundaries and their current limits are described in [STATUS.md](../STATUS.md); live-provider verification and the full audit are outstanding.

The separate self-hosted mail server is experimental. Encrypted mailbox credentials and a read-only IMAP folder-list helper exist, but they are not wired to the workspace or synchronization worker. See [CURRENT_HANDOFF.md](../CURRENT_HANDOFF.md) for the implementation boundary.
