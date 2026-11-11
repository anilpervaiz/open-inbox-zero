import type { ExecutedAction, ExecutedRule, PrismaClient } from '@prisma/client';
import type { LanguageModel } from 'ai';
import type { EmailProvider, ParsedMessage } from '../../mail-provider/types';
import { senderAddress } from '../../rule/static-from-risk';
import { analyzeSenderPattern } from '../../rule/ai-sender-pattern-learning';
import { getActionItemsWithAiArgs } from './choose-args';
import { executeAct } from './execute';
import { findMatchingRules } from './match-rules';
import { recordIncomingMessage, recordSentReply } from '../../reply-tracker/events';

async function retryLearning(prisma: PrismaClient, emailAccountId: string, from: string, execution: Pick<ExecutedRule, 'status' | 'ruleId' | 'selectionMetadata'>): Promise<void> {
  const metadata = execution.selectionMetadata;
  if (execution.status !== 'APPLIED' || !execution.ruleId || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.stage !== 'AI') return;
  const sender = senderAddress(from);
  if (!sender) throw new Error('Invalid sender address for pattern learning');
  await analyzeSenderPattern(prisma, { emailAccountId, fromEmail: sender, ruleId: execution.ruleId });
}

async function syncReplyTracking(input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; messageId: string; actions: readonly ExecutedAction[] }): Promise<void> {
  const { prisma, provider, emailAccountId, messageId, actions } = input;
  await recordIncomingMessage({ prisma, provider, emailAccountId, messageId, requiresReply: actions.some((action) => action.type === 'TRACK_THREAD' && action.status === 'COMPLETED') });
  for (const action of actions) {
    if (action.type !== 'REPLY' || action.status !== 'COMPLETED' || !action.sentMessageId) continue;
    // Real providers may deliver the sent message through a later sync event.
    const sent = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: action.sentMessageId } }, select: { id: true } });
    if (sent) await recordSentReply({ prisma, provider, emailAccountId, messageId: action.sentMessageId });
  }
}

/** Process one persisted account message once, keeping AI selection and draft generation separate. */
export async function runRules(input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; message: ParsedMessage; model?: LanguageModel }) {
  const { prisma, provider, emailAccountId } = input;
  const requested = input.message;
  if (provider.emailAccountId !== emailAccountId) throw new Error('Provider is bound to a different account');
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account || account.provider !== provider.providerName) throw new Error('Email account or provider mismatch');
  const existing = await prisma.executedRule.findUnique({ where: { emailAccountId_threadId_messageId: { emailAccountId, threadId: requested.threadId, messageId: requested.id } }, include: { actionItems: true } });
  if (existing) {
    const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: requested.id } } });
    if (!stored || stored.threadId !== existing.threadId) throw new Error('Message does not belong to this account and thread');
    await retryLearning(prisma, emailAccountId, stored.fromEmail, existing);
    await syncReplyTracking({ prisma, provider, emailAccountId, messageId: requested.id, actions: existing.actionItems });
    return { match: null, execution: existing };
  }
  const message = await provider.getMessage(requested.id);
  if (message.threadId !== requested.threadId) throw new Error('Provider message belongs to another thread');
  const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: message.id } } });
  if (!stored || stored.threadId !== message.threadId || senderAddress(stored.fromEmail) !== senderAddress(message.headers.from)) throw new Error('Message does not belong to this account and thread');
  if (message.labelIds.includes('SENT')) {
    await recordSentReply({ prisma, provider, emailAccountId, messageId: message.id });
    return { match: null, execution: null };
  }
  const match = await findMatchingRules({ prisma, provider, account, message, model: input.model });
  if (!match) {
    await syncReplyTracking({ prisma, provider, emailAccountId, messageId: message.id, actions: [] });
    return { match: null, execution: null };
  }
  let actions = match.actions;
  if (actions.some((action) => action.type === 'DRAFT_EMAIL' || action.type === 'REPLY')) {
    actions = await getActionItemsWithAiArgs({ prisma, emailAccountId, message, actions, account, model: input.model });
  }
  const execution = await executeAct({ prisma, provider, emailAccountId, message, rule: match.rule, actions, matchReasons: match.reasons, selectionMetadata: match.metadata, hasVerifiedSenderReplyHistory: match.hasVerifiedSenderReplyHistory });
  await retryLearning(prisma, emailAccountId, stored.fromEmail, execution);
  await syncReplyTracking({ prisma, provider, emailAccountId, messageId: message.id, actions: execution.actionItems });
  return { match, execution };
}
