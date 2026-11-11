import type { Action, EmailAccount, Group, GroupItem, PrismaClient, Rule } from '@prisma/client';
import type { LanguageModel } from 'ai';
import type { EmailProvider, ParsedMessage } from '../../mail-provider/types';
import { senderAddress } from '../../rule/static-from-risk';
import { getStaticMatchDetails } from '../../rule/email-from-pattern';
import { findMatchingGroup } from '../../group/find-matching-group';
import { isColdEmail } from '../../cold-email/is-cold-email';
import { aiChooseRule, getConfiguredModel, sortRulesByCanonicalOrder } from './ai-choose-rule';
import type { MatchReason, RuleSelectionMetadata } from './execute';

export const NO_REPLY_PREFIXES = ['noreply@', 'no-reply@', 'notifications@', 'newsletter@', 'updates@'] as const;
type GroupWithItems = Group & { items: GroupItem[] };
export type RuleWithRelations = Rule & { actions: Action[]; group: GroupWithItems | null };
export type RuleMatch = { rule: RuleWithRelations | null; actions: Action[]; reasons: MatchReason[]; metadata: RuleSelectionMetadata; hasVerifiedSenderReplyHistory: boolean };

/** Only sent messages in the account's own mailbox establish prior user reply history. */
export async function checkSenderReplyHistory(prisma: PrismaClient, account: EmailAccount, sender: string, before?: Date): Promise<boolean> {
  const sent = await prisma.emailMessage.findMany({ where: { emailAccountId: account.id, fromEmail: { equals: account.email, mode: 'insensitive' }, labels: { has: 'SENT' }, ...(before ? { internalDate: { lt: before } } : {}) }, select: { toEmail: true } });
  return sent.some((message) => message.toEmail.split(',').some((recipient) => senderAddress(recipient) === sender));
}

export function isCalendarInvite(message: ParsedMessage): boolean {
  return [message.contentType, ...(message.mimeTypes ?? [])].some((type) => type && /^text\/calendar(?:\s*;|\s*$)/i.test(type))
    || (message.attachmentNames ?? []).some((name) => /\.ics$/i.test(name))
    || /(?:BEGIN:VCALENDAR|content-type\s*:\s*text\/calendar|\.ics\b)/i.test(`${message.headers.subject}\n${message.textPlain}\n${message.textHtml ?? ''}`);
}

function syntheticColdAction(type: 'LABEL' | 'ARCHIVE'): Action {
  return { id: `synthetic-cold-${type.toLowerCase()}`, ruleId: '', type, label: type === 'LABEL' ? 'Cold Emails' : null, subject: null, content: null, to: null, cc: null, bcc: null, url: null, delayMinutes: null, autoSend: false };
}

/** Run system checks, deterministic matches, unknown-sender cold gate, then AI routing. */
export async function findMatchingRules(input: { prisma: PrismaClient; provider: EmailProvider; account: EmailAccount; message: ParsedMessage; model?: LanguageModel }): Promise<RuleMatch | null> {
  const { prisma, provider, account, message } = input;
  const sender = senderAddress(message.headers.from);
  if (!sender) throw new Error('Invalid sender address');
  const [storedRules, groups, feedback, hasVerifiedSenderReplyHistory, priorInbound] = await Promise.all([
    prisma.rule.findMany({ where: { emailAccountId: account.id }, include: { actions: true, group: { include: { items: true } } } }),
    prisma.group.findMany({ where: { emailAccountId: account.id }, include: { items: true } }),
    prisma.classificationFeedback.findMany({ where: { emailAccountId: account.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    checkSenderReplyHistory(prisma, account, sender, message.internalDate),
    prisma.emailMessage.findFirst({ where: { emailAccountId: account.id, fromEmail: { equals: sender, mode: 'insensitive' }, messageId: { not: message.id }, internalDate: { lt: message.internalDate } }, select: { id: true } }),
  ]);
  if (storedRules.some((rule) => rule.group && rule.group.emailAccountId !== account.id)) throw new Error('Rule references a group owned by another account');
  const isReply = provider.isReplyInThread(message);
  const rules = sortRulesByCanonicalOrder(storedRules).filter((rule) => !isReply || rule.runOnThreads);
  const makeMatch = (rule: RuleWithRelations, type: MatchReason['type'], detail: string, extra: Partial<MatchReason> = {}): RuleMatch => ({
    rule, actions: rule.actions, reasons: [{ type, detail, ...extra }], metadata: { stage: type, ruleName: rule.name }, hasVerifiedSenderReplyHistory,
  });

  // System pre-checks precede static rules, but only select an existing system rule.
  const prefix = NO_REPLY_PREFIXES.find((entry) => sender.startsWith(entry));
  const systemType = isCalendarInvite(message) ? 'CALENDAR' : prefix === 'newsletter@' ? 'NEWSLETTER' : prefix ? 'NOTIFICATION' : null;
  const systemRule = systemType && rules.find((rule) => rule.systemType === systemType);
  if (systemRule) return makeMatch(systemRule, 'SYSTEM', isCalendarInvite(message) ? 'Calendar invitation' : `No-reply sender: ${prefix}`);

  // Learned and user groups have precedence so a previously learned sender bypasses AI.
  for (const rule of rules) {
    const groupMatches = rule.group ? findMatchingGroup(rule.group, message) : false;
    const details = getStaticMatchDetails(rule, message);
    const staticSatisfied = !details.configuredFields.length || details.matches;
    const groupSatisfied = !rule.group || groupMatches;
    const combined = rule.conditionalOperator === 'AND' ? staticSatisfied && groupSatisfied : true;
    const deterministicOnly = !rule.instructions?.trim() || rule.conditionalOperator === 'OR';
    if (groupMatches && combined && deterministicOnly) return makeMatch(rule, 'GROUP', `Sender group: ${rule.group!.name}`);
    if (details.matches && combined && deterministicOnly) {
      return makeMatch(rule, 'STATIC', `Matched ${details.matchedFields.join(', ')}`, { matchedFields: details.matchedFields });
    }
  }

  // Subject/body group membership does not authenticate or establish familiarity with a sender.
  const inKnownGroup = groups.some((group) => findMatchingGroup({ items: group.items.filter((item) => item.type === 'FROM' || item.exclude) }, message));
  if (!hasVerifiedSenderReplyHistory && !priorInbound && !inKnownGroup && account.coldEmailBlocker !== 'DISABLED') {
    const cold = await isColdEmail({ prisma, account, message, hasSenderHistory: false, inKnownGroup: false, model: input.model ?? getConfiguredModel() });
    if (cold.isCold) {
      const actions = [syntheticColdAction('LABEL'), ...(account.coldEmailBlocker === 'LABEL_AND_ARCHIVE' ? [syntheticColdAction('ARCHIVE')] : [])];
      return { rule: null, actions, reasons: [{ type: 'COLD', detail: cold.reason }], metadata: { stage: 'COLD', ruleName: 'Cold Emails' }, hasVerifiedSenderReplyHistory };
    }
  }
  // AND conditions constrain the candidates offered to the AI; an unmatched static or group condition cannot be ignored.
  const aiCandidates = rules.filter((rule) => {
    if (rule.conditionalOperator !== 'AND') return true;
    const details = getStaticMatchDetails(rule, message);
    if (details.configuredFields.length && !details.matches) return false;
    return !rule.group || findMatchingGroup(rule.group, message);
  });
  const ai = await aiChooseRule({ message, rules: aiCandidates, account, feedback, model: input.model });
  if (!ai.rule) return null;
  return { rule: ai.rule, actions: ai.rule.actions, reasons: [{ type: 'AI', detail: ai.reasoning }], metadata: { ...ai.selectionMetadata, ruleName: ai.rule.name }, hasVerifiedSenderReplyHistory };
}
