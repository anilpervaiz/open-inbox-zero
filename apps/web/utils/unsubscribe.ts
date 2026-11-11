import { load } from "cheerio";
import type { PrismaClient } from "@prisma/client";
import { demoSeed } from "../scripts/seed-data";
import { EmulatedMailProvider } from "./mail-provider/emulated-provider";
import type { EmailProvider, ParsedMessage } from "./mail-provider/types";
import { senderAddress } from "./rule/static-from-risk";
import { executeOneClickPost, parsePublicHttpsUrl, validatePublicHttpsUrl } from "./secure-webhook";
import { verifyProviderUnsubscribeDkim } from "./dkim-unsubscribe";

export type MailtoOption = { to: string; subject: string; body: string };
export type UnsubscribeOptions = { oneClickUrl: string | null; mailto: MailtoOption | null; manualLinks: string[] };

function safeCandidate(value: string): string | null {
  try { return parsePublicHttpsUrl(value).href; } catch { return null; }
}
function parseMailto(value: string): MailtoOption | null {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "mailto:" || parsed.hash || parsed.username || parsed.password) return null;
  let recipient: string;
  try { recipient = decodeURIComponent(parsed.pathname); } catch { return null; }
  const to = senderAddress(recipient);
  if (!to || to !== recipient.toLowerCase() || [...parsed.searchParams.keys()].some((key) => !["subject", "body"].includes(key.toLowerCase()))) return null;
  const subjects = [...parsed.searchParams.entries()].filter(([key]) => key.toLowerCase() === "subject").map(([, item]) => item);
  const bodies = [...parsed.searchParams.entries()].filter(([key]) => key.toLowerCase() === "body").map(([, item]) => item);
  if (subjects.length > 1 || bodies.length > 1) return null;
  const subject = subjects[0] ?? "Unsubscribe";
  const body = bodies[0] ?? "Please unsubscribe me from this mailing list.";
  if (/[\r\n\0]/.test(subject) || subject.length > 998 || body.length > 4000 || body.includes("\0")) return null;
  return { to, subject, body };
}

/** Parse options without following any link. Returned URLs still need DNS verification at use time. */
export function parseUnsubscribeOptions(input: { listUnsubscribe?: string | null; listUnsubscribePost?: string | null; html?: string | null }): UnsubscribeOptions {
  const items = [...(input.listUnsubscribe ?? "").matchAll(/<([^<>]+)>/g)].map((item) => item[1].trim());
  const httpItems = items.filter((item) => /^https?:/i.test(item));
  const https = httpItems.length === 1 ? safeCandidate(httpItems[0]) : null;
  const oneClickUrl = /^List-Unsubscribe=One-Click$/i.test((input.listUnsubscribePost ?? "").trim()) ? https : null;
  const mailto = items.map(parseMailto).find((item): item is MailtoOption => item !== null) ?? null;
  const manualLinks: string[] = [];
  if (input.html) {
    const $ = load(input.html);
    $("a[href]").each((_index, element) => {
      const link = $(element);
      if (!/\b(unsubscribe|opt[ -]?out)\b/i.test(link.text().trim())) return;
      const value = safeCandidate(link.attr("href") ?? "");
      if (value && !manualLinks.includes(value)) manualLinks.push(value);
    });
  }
  return { oneClickUrl, mailto, manualLinks };
}

export type UnsubscribeResult =
  | { kind: "unsubscribed"; simulated: boolean }
  | { kind: "draft_created"; draftId: string }
  | { kind: "manual_link"; url: string };

function isUnmodifiedSyntheticDemo(provider: EmailProvider, message: ParsedMessage, accountEmail: string): boolean {
  if (!(provider instanceof EmulatedMailProvider)) return false;
  const account = demoSeed.accounts.find((candidate) => candidate.id === provider.emailAccountId && candidate.email === accountEmail);
  const seed = demoSeed.messages.find((candidate) => candidate.accountId === account?.id && candidate.id === message.id);
  return Boolean(seed && seed.threadId === message.threadId && seed.fromEmail === message.headers.from && seed.toEmail === message.headers.to && seed.listUnsubscribe === message.headers.listUnsubscribe && seed.listUnsubscribePost === message.headers.listUnsubscribePost);
}

/** User-consented unsubscribe; transport and credentials are never accepted from email content. */
export async function unsubscribeSender(input: { prisma: PrismaClient; provider: EmailProvider; emailAccountId: string; newsletterId: string; messageId: string; method: "one_click" | "mailto" | "manual"; userConfirmed: boolean }): Promise<UnsubscribeResult> {
  const { prisma, provider, emailAccountId } = input;
  if (input.userConfirmed !== true) throw new Error("Unsubscribe requires user consent");
  if (!["one_click", "mailto", "manual"].includes(input.method)) throw new Error("Invalid unsubscribe method");
  if (provider.emailAccountId !== emailAccountId) throw new Error("Provider does not belong to account");
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account || account.provider !== provider.providerName) throw new Error("Email account or provider mismatch");
  const newsletter = await prisma.newsletter.findFirst({ where: { id: input.newsletterId, emailAccountId } });
  if (!newsletter) throw new Error("Newsletter not found for account");
  const stored = await prisma.emailMessage.findUnique({ where: { emailAccountId_messageId: { emailAccountId, messageId: input.messageId } } });
  const message = await provider.getMessage(input.messageId);
  const sender = senderAddress(message.headers.from);
  if (!stored || stored.threadId !== message.threadId || !sender || senderAddress(stored.fromEmail) !== sender || senderAddress(newsletter.fromEmail) !== sender) throw new Error("Message does not belong to newsletter and account");
  const options = parseUnsubscribeOptions({ listUnsubscribe: message.headers.listUnsubscribe, listUnsubscribePost: message.headers.listUnsubscribePost, html: message.textHtml });
  if (input.method === "manual") {
    if (!options.manualLinks[0]) throw new Error("No manual unsubscribe link available");
    return { kind: "manual_link", url: await validatePublicHttpsUrl(options.manualLinks[0]) };
  }
  if (input.method === "mailto" && !options.mailto) throw new Error("No valid unsubscribe mailto available");
  if (input.method === "one_click" && !options.oneClickUrl) throw new Error("No valid one-click unsubscribe available");
  const simulated = input.method === "one_click" && isUnmodifiedSyntheticDemo(provider, message, account.email);
  if (input.method === "one_click" && !simulated) {
    let proof: Awaited<ReturnType<typeof verifyProviderUnsubscribeDkim>>;
    try { proof = await verifyProviderUnsubscribeDkim({ provider, message }); }
    catch { throw new Error("One-click unsubscribe requires verified DKIM coverage of both unsubscribe headers"); }
    const signed = new Set(proof?.signedHeaders.map((header) => header.toLowerCase()) ?? []);
    if (!proof?.valid || !signed.has("list-unsubscribe") || !signed.has("list-unsubscribe-post")) throw new Error("One-click unsubscribe requires verified DKIM coverage of both unsubscribe headers");
  }
  // The lock remains on an indeterminate external outcome: retrying a POST or
  // draft creation blindly could repeat an action that actually succeeded.
  let lock;
  try { lock = await prisma.threadExecutionLock.create({ data: { emailAccountId, threadId: `unsubscribe:${newsletter.id}` } }); }
  catch { throw new Error("Unsubscribe is in progress or requires reconciliation"); }
  let mayHaveActed = false;
  try {
    const current = await prisma.newsletter.findFirstOrThrow({ where: { id: newsletter.id, emailAccountId } });
    if (input.method === "one_click" && current.status === "UNSUBSCRIBED") return { kind: "unsubscribed", simulated };
    if (input.method === "mailto") {
      mayHaveActed = true;
      const draft = await provider.createDraft(options.mailto!);
      mayHaveActed = false;
      return { kind: "draft_created", draftId: draft.draftId };
    }
    if (!simulated) { mayHaveActed = true; await executeOneClickPost(options.oneClickUrl!); }
    await prisma.newsletter.update({ where: { id: newsletter.id }, data: { status: "UNSUBSCRIBED" } });
    mayHaveActed = false;
    return { kind: "unsubscribed", simulated };
  } finally {
    if (!mayHaveActed) await prisma.threadExecutionLock.deleteMany({ where: { id: lock.id, emailAccountId } });
  }
}

/** Recompute counts from current account-scoped incoming messages without double counting. */
export async function refreshSenderAnalytics(prisma: PrismaClient, emailAccountId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [messages, previous] = await Promise.all([
      tx.emailMessage.findMany({ where: { emailAccountId }, orderBy: { internalDate: "desc" } }),
      tx.newsletter.findMany({ where: { emailAccountId } }),
    ]);
    const buckets = new Map<string, typeof messages>();
    for (const message of messages) {
      if (message.labels.some((label) => label === "SENT" || label === "DRAFT")) continue;
      const sender = senderAddress(message.fromEmail);
      if (!sender) continue;
      const bucket = buckets.get(sender) ?? [];
      bucket.push(message);
      buckets.set(sender, bucket);
    }
    const existingBySender = new Map(previous.flatMap((item) => { const address = senderAddress(item.fromEmail); return address ? [[address, item] as const] : []; }));
    for (const [address, bucket] of buckets) {
      const old = existingBySender.get(address);
      if (!old && !bucket.some((message) => message.listUnsubscribe || message.labels.some((label) => label.toLowerCase() === "newsletters"))) continue;
      const header = bucket.find((message) => message.listUnsubscribe)?.listUnsubscribe ?? old?.listUnsubscribe ?? null;
      const counts = { messageCount: bucket.length, readCount: bucket.filter((message) => !message.unread).length, archivedCount: bucket.filter((message) => message.archived).length, listUnsubscribe: header };
      if (old) await tx.newsletter.update({ where: { id: old.id }, data: counts });
      else await tx.newsletter.create({ data: { emailAccountId, fromEmail: address, ...counts } });
      existingBySender.delete(address);
    }
    for (const item of existingBySender.values()) await tx.newsletter.update({ where: { id: item.id }, data: { messageCount: 0, readCount: 0, archivedCount: 0 } });
  }, { timeout: 30_000 });
}
