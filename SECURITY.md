# Security

Open Inbox Zero is under development and has not completed its full security audit. Do not assume the local demo, synthetic evaluation, simulated provider tests, or CI configuration establish production readiness.

Please report suspected vulnerabilities privately through the repository's private security advisory feature. Include affected versions, reproduction steps, impact, and a safe way to contact you. Do not include live mailbox contents, working OAuth tokens, or other credentials in a public issue. If private reporting is unavailable, ask the maintainers for a private channel without posting exploit details.

The service stores encrypted provider credentials; protect `TOKEN_ENCRYPTION_KEY`, the authentication secret, database backups, API keys, and the deployment environment. Access keys are displayed once and may be revoked. Provider permissions include reading and organizing mail, drafting, and sending where configured. Automated actions are audited, but a provider timeout or process interruption can leave an uncertain state that requires reconciliation. See [STATUS.md](STATUS.md) for current gaps.
