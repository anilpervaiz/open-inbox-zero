import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Action, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { resolveMailProvider } from '../mail-provider/provider-resolver';
import { cacheProviderMessage } from '../worker/provider-sync';
import { enqueueProviderSync, getProviderSyncQueue } from '../worker/provider-sync-queue';
import { getEmailForLLM } from '../get-email-from-message';
import { senderAddress } from '../rule/static-from-risk';
import { getActionItemsWithAiArgs } from '../ai/choose-rule/choose-args';
import { runRules } from '../ai/choose-rule/run-rules';
import { undoExecutedRule } from '../ai/choose-rule/execute';
import { unsubscribeSender } from '../unsubscribe';

const id = z.string().trim().min(1).max(256);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = () => ({ content: [{ type: 'text' as const, text: 'The requested operation could not be completed.' }], isError: true });

/** Every tool re-checks ownership before resolving mailbox credentials. */
export function createInboxMcpServer(prisma: PrismaClient, userId: string) {
  const server = new McpServer({ name: 'open-inbox-zero', version: '0.1.0' });
  async function context(accountId: string) {
    const account = await prisma.emailAccount.findFirst({ where: { id: accountId, userId } });
    if (!account) throw new Error('Account unavailable');
    return { account, provider: await resolveMailProvider(prisma, account.id) };
  }
  async function refresh(account: { id: string; provider: string }, threadId: string) {
    if (account.provider === 'emulator') return {};
    try { await enqueueProviderSync(getProviderSyncQueue(), { provider: 'refresh', emailAccountId: account.id, threadId }); return { refreshPending: true }; }
    catch { return { refreshUnscheduled: true }; }
  }
  server.registerTool('list_threads', { description: 'List mailbox threads in a split inbox.', inputSchema: { accountId: id, tab: z.enum(['all', 'important', 'needs_reply', 'awaiting_reply', 'cold', 'newsletters']).default('all'), limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true } }, async ({ accountId, tab, limit }) => {
    try {
      await context(accountId);
      const [messages, trackers, cold, newsletters] = await Promise.all([
        prisma.emailMessage.findMany({ where: { emailAccountId: accountId }, orderBy: { internalDate: 'desc' }, take: 1000 }),
        prisma.threadTracker.findMany({ where: { emailAccountId: accountId, resolved: false } }),
        prisma.coldEmail.findMany({ where: { emailAccountId: accountId, status: { in: ['AI_LABELED_COLD', 'USER_MARKED_COLD'] } } }),
        prisma.newsletter.findMany({ where: { emailAccountId: accountId }, select: { fromEmail: true } }),
      ]);
      const seen = new Set<string>();
      const rows = messages.filter(m => {
        if (seen.has(m.threadId)) return false;
        seen.add(m.threadId);
        if (tab === 'important') return !m.archived && m.labels.includes('INBOX');
        if (tab === 'needs_reply' || tab === 'awaiting_reply') return trackers.some(t => t.threadId === m.threadId && t.type === (tab === 'needs_reply' ? 'NEEDS_REPLY' : 'AWAITING_REPLY'));
        if (tab === 'cold') return cold.some(c => c.threadId === m.threadId);
        if (tab === 'newsletters') return newsletters.some(n => n.fromEmail.toLowerCase() === m.fromEmail.toLowerCase());
        return true;
      }).slice(0, limit).map(m => ({ threadId: m.threadId, messageId: m.messageId, from: m.fromEmail, subject: m.subject, snippet: m.snippet, date: m.internalDate.toISOString() }));
      return result({ threads: rows });
    } catch { return failure(); }
  });
  server.registerTool('get_thread', { description: 'Read sanitized thread messages and drafts.', inputSchema: { accountId: id, threadId: id }, annotations: { readOnlyHint: true } }, async ({ accountId, threadId }) => {
    try { const { provider } = await context(accountId); const thread = await provider.getThread(threadId); return result({ threadId, messages: thread.messages.map(m => ({ id: m.id, labels: m.labelIds, ...getEmailForLLM(m) })) }); }
    catch { return failure(); }
  });
  server.registerTool('create_reply_draft', { description: 'Create or update a draft reply using saved knowledge and examples. This never sends mail.', inputSchema: { accountId: id, threadId: id, draftId: id.optional(), instructions: z.string().max(4000).default('Write a helpful reply.') }, annotations: { destructiveHint: false, openWorldHint: false } }, async ({ accountId, threadId, draftId, instructions }) => {
    try {
      const { account, provider } = await context(accountId); const thread = await provider.getThread(threadId);
      if (thread.id !== threadId || thread.messages.some(m => m.threadId !== threadId)) throw new Error('Provider thread mismatch');
      const message = [...thread.messages].reverse().find(m => !m.labelIds.includes('SENT') && !m.labelIds.includes('DRAFT'));
      if (!message) throw new Error('Incoming message not found');
      const to = senderAddress(message.headers.from); if (!to) throw new Error('Invalid sender');
      const action: Action = { id: 'mcp-draft', ruleId: '', type: 'DRAFT_EMAIL', label: null, subject: null, content: instructions, to: null, cc: null, bcc: null, url: null, delayMinutes: null, autoSend: false };
      const [draft] = await getActionItemsWithAiArgs({ prisma, emailAccountId: accountId, message, actions: [action], account });
      const input = { threadId, to, subject: /^re:/i.test(message.headers.subject) ? message.headers.subject : `Re: ${message.headers.subject}`, body: draft.content ?? '', inReplyTo: message.headers.messageId };
      const created = draftId ? await provider.updateDraft({ ...input, draftId }) : await provider.createDraft(input);
      return result({ ...created, ...await refresh(account, threadId) });
    } catch { return failure(); }
  });
  server.registerTool('run_rules_on_thread', { description: 'Run configured rules on the newest incoming message in a thread.', inputSchema: { accountId: id, threadId: id }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ accountId, threadId }) => {
    try { const { account, provider } = await context(accountId); const thread = await provider.getThread(threadId); if (thread.id !== threadId || thread.messages.some(m => m.threadId !== threadId)) throw new Error('Provider thread mismatch'); if (account.provider !== 'emulator') for (const item of thread.messages) await cacheProviderMessage(prisma, accountId, item); const message = [...thread.messages].reverse().find(m => !m.labelIds.includes('SENT') && !m.labelIds.includes('DRAFT')); if (!message) throw new Error('Incoming message not found'); const output = await runRules({ prisma, provider, emailAccountId: accountId, message }); return result({ execution: output.execution, ...await refresh(account, threadId) }); }
    catch { return failure(); }
  });
  server.registerTool('unsubscribe_sender', { description: 'Unsubscribe using verified list headers after explicit user confirmation.', inputSchema: { accountId: id, newsletterId: id, messageId: id, method: z.enum(['one_click', 'mailto']), userConfirmed: z.literal(true) }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ accountId, newsletterId, messageId, method, userConfirmed }) => {
    try { const { provider } = await context(accountId); return result(await unsubscribeSender({ prisma, provider, emailAccountId: accountId, newsletterId, messageId, method, userConfirmed })); }
    catch { return failure(); }
  });
  server.registerTool('undo_executed_rule', { description: 'Undo a previously executed rule.', inputSchema: { accountId: id, executionId: id }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ accountId, executionId }) => {
    try { const { account, provider } = await context(accountId); const execution = await prisma.executedRule.findFirst({ where: { id: executionId, emailAccountId: accountId }, select: { threadId: true } }); if (!execution) throw new Error('Execution unavailable'); const undone = await undoExecutedRule({ prisma, provider, emailAccountId: accountId, executedRuleId: executionId }); return result({ ...undone, ...await refresh(account, execution.threadId) }); }
    catch { return failure(); }
  });
  return server;
}
