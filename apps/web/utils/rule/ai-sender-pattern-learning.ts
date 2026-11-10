import { Prisma, type PrismaClient } from "@prisma/client";

export interface SenderPatternInput { emailAccountId: string; fromEmail: string; ruleId: string }
export interface SenderFeedbackInput {
  emailAccountId: string;
  fromEmail: string;
  subject: string;
  wrongRuleId: string;
  correctRuleId?: string;
  note?: string;
}

function senderAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw new Error("Invalid sender email address");
  return address;
}

/** Promote only persisted, applied AI classifications; never overwrite user-authored patterns. */
export async function analyzeSenderPattern(prisma: PrismaClient, input: SenderPatternInput): Promise<boolean> {
  const sender = senderAddress(input.fromEmail);
  return prisma.$transaction(async (tx) => {
    const account = await tx.emailAccount.findUnique({ where: { id: input.emailAccountId }, select: { autoCategorizeSenders: true } });
    if (!account?.autoCategorizeSenders) return false;
    const rule = await tx.rule.findFirst({ where: { id: input.ruleId, emailAccountId: input.emailAccountId }, include: { group: { include: { rules: { select: { id: true } } } } } });
    if (!rule) throw new Error("Rule not found in account");
    const corrections = await tx.classificationFeedback.count({ where: { emailAccountId: input.emailAccountId, fromEmail: { equals: sender, mode: "insensitive" } } });
    if (corrections > 0) return false;
    const messages = await tx.emailMessage.findMany({ where: { emailAccountId: input.emailAccountId, fromEmail: { equals: sender, mode: "insensitive" } }, select: { messageId: true } });
    if (messages.length < 2) return false;
    const executions = await tx.executedRule.findMany({ where: { emailAccountId: input.emailAccountId, messageId: { in: messages.map((message) => message.messageId) }, status: "APPLIED" }, select: { ruleId: true, selectionMetadata: true } });
    const aiExecutions = executions.filter((execution) => {
      const metadata = execution.selectionMetadata;
      return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) && metadata.stage === "AI";
    });
    if (aiExecutions.length < 2 || aiExecutions.some((execution) => execution.ruleId !== rule.id)) return false;
    // A shared group would apply this learned sender to unrelated rules, so do not promote it.
    if (rule.group && (rule.group.emailAccountId !== input.emailAccountId || rule.group.rules.some((candidate) => candidate.id !== rule.id))) return false;
    const group = rule.group ?? await tx.group.create({ data: { emailAccountId: input.emailAccountId, name: `Learned senders: ${rule.name}` } });
    if (!rule.groupId) await tx.rule.update({ where: { id: rule.id }, data: { groupId: group.id } });
    const existing = await tx.groupItem.findFirst({ where: { groupId: group.id, type: "FROM", value: { equals: sender, mode: "insensitive" } } });
    if (existing) return false;
    await tx.groupItem.create({ data: { groupId: group.id, type: "FROM", value: sender, source: "AI_LEARNED" } });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Unlearn the incorrect rule without changing user-authored groups, then record the correction. */
export async function recordLabelRemovalLearning(prisma: PrismaClient, input: SenderFeedbackInput): Promise<void> {
  const sender = senderAddress(input.fromEmail);
  await prisma.$transaction(async (tx) => {
    const ruleIds = [input.wrongRuleId, ...(input.correctRuleId ? [input.correctRuleId] : [])];
    const rules = await tx.rule.findMany({ where: { emailAccountId: input.emailAccountId, id: { in: ruleIds } }, select: { id: true } });
    if (ruleIds.some((id) => !rules.some((rule) => rule.id === id))) throw new Error("Rule not found in account");
    await tx.groupItem.deleteMany({ where: { type: "FROM", source: "AI_LEARNED", value: { equals: sender, mode: "insensitive" }, group: { emailAccountId: input.emailAccountId, rules: { some: { id: input.wrongRuleId } } } } });
    await tx.classificationFeedback.create({ data: { emailAccountId: input.emailAccountId, fromEmail: sender, subject: input.subject, wrongRuleId: input.wrongRuleId, correctRuleId: input.correctRuleId, note: input.note } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
