import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { LanguageModel } from 'ai';
import { parseRawEmail } from '../../../../packages/mail-core/src/raw-email';
import { sanitizeEmailHtml } from '../../../../packages/mail-ui/src/index';
import { runRules } from '../ai/choose-rule/run-rules';
import { withSelfHostedImapClient } from '../mail-provider/self-hosted-imap';
import { SelfHostedMailProvider } from '../mail-provider/self-hosted-provider';
import { resolveSelfHostedThreadId } from '../mail-provider/self-hosted-threading';
import type { EmailProvider, ParsedMessage } from '../mail-provider/types';
import { senderAddress } from '../rule/static-from-risk';

const MAX_SIGNED_64BIT = 9223372036854775807n;

export function parseSafeModSeq(modseq: bigint | number | string | null | undefined): bigint | null {
  if (modseq === null || modseq === undefined || modseq === '') return null;
  try {
    let val: bigint;
    if (typeof modseq === 'bigint') {
      val = modseq;
    } else if (typeof modseq === 'number') {
      if (!Number.isSafeInteger(modseq)) return null;
      val = BigInt(modseq);
    } else if (typeof modseq === 'string') {
      const trimmed = modseq.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      val = BigInt(trimmed);
    } else {
      return null;
    }
    if (val <= 0n || val > MAX_SIGNED_64BIT) return null;
    return val;
  } catch {
    return null;
  }
}

function computeBodyFingerprint(textBody: string, htmlBody?: string | null): string {
  const content = (textBody || (htmlBody ?? '')).trim().replace(/\r\n/g, '\n');
  return createHash('sha256').update(content).digest('hex');
}

function isInboxFolder(f: { path: string; specialUse?: string | null }): boolean {
  return (
    f.path.toUpperCase() === 'INBOX' ||
    f.path.split(/[./\\]/).pop()?.toUpperCase() === 'INBOX' ||
    f.specialUse?.toLowerCase() === '\\inbox'
  );
}

function isArchiveFolder(f: { path: string; specialUse?: string | null }): boolean {
  if (f.specialUse?.toLowerCase() === '\\archive') return true;
  const lower = f.path.toLowerCase();
  const lastPart = lower.split(/[./\\]/).pop() ?? '';
  return ['archive', 'archives'].includes(lower) || ['archive', 'archives'].includes(lastPart);
}

function isJunkFolder(f: { path: string; specialUse?: string | null }): boolean {
  if (f.specialUse?.toLowerCase() === '\\junk') return true;
  const lower = f.path.toLowerCase();
  const lastPart = lower.split(/[./\\]/).pop() ?? '';
  return ['junk', 'spam', 'junk email'].includes(lower) || ['junk', 'spam', 'junk email'].includes(lastPart);
}

function isDraftsFolder(f: { path: string; specialUse?: string | null }): boolean {
  if (f.specialUse?.toLowerCase() === '\\drafts') return true;
  const lower = f.path.toLowerCase();
  const lastPart = lower.split(/[./\\]/).pop() ?? '';
  return ['drafts', 'draft'].includes(lower) || ['drafts', 'draft'].includes(lastPart);
}

function isSentFolder(f: { path: string; specialUse?: string | null }): boolean {
  if (f.specialUse?.toLowerCase() === '\\sent') return true;
  const lower = f.path.toLowerCase();
  const lastPart = lower.split(/[./\\]/).pop() ?? '';
  return ['sent', 'sent messages', 'sent items'].includes(lower) || ['sent', 'sent messages', 'sent items'].includes(lastPart);
}

function isStandardFolder(f: { path: string; specialUse?: string | null }): boolean {
  return isInboxFolder(f) || isArchiveFolder(f) || isJunkFolder(f) || isDraftsFolder(f) || isSentFolder(f);
}

export type SyncSelfHostedAccountInput = {
  prisma: PrismaClient;
  emailAccountId: string;
  mode: 'bootstrap' | 'incremental';
  folderPath?: string;
  env?: Record<string, string | undefined>;
  createClient?: Parameters<typeof withSelfHostedImapClient>[0]['createClient'];
  runRulesFn?: (input: {
    prisma: PrismaClient;
    provider: EmailProvider;
    emailAccountId: string;
    message: ParsedMessage;
    model?: LanguageModel;
  }) => Promise<unknown>;
  model?: LanguageModel;
};

export async function syncSelfHostedAccount(input: SyncSelfHostedAccountInput): Promise<void> {
  const { prisma, emailAccountId, mode, folderPath, env, createClient, runRulesFn, model } = input;

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { id: true, userId: true, email: true, provider: true, initialSyncStatus: true },
  });
  if (!account || account.provider !== 'selfhosted') {
    throw new Error('Self-hosted account unavailable');
  }

  if (mode === 'bootstrap') {
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { initialSyncStatus: 'RUNNING' },
    });
  }

  const newInboxMessagesToRunRules: ParsedMessage[] = [];
  const pendingVanished: Array<{
    id: string;
    messageId: string;
    labels: string[];
    folderPath: string;
    uidValidity: bigint;
  }> = [];

  try {
    await withSelfHostedImapClient(
      { prisma, userId: account.userId, accountId: account.id, env, createClient },
      async (client) => {
        const allFolders = await client.list();
        if (allFolders.length > 1000) throw new Error('Too many mail folders');

        let foldersToScan: typeof allFolders = [];
        if (folderPath && mode === 'incremental') {
          const target = allFolders.find(
            (f) => f.path === folderPath || f.path.toLowerCase() === folderPath.toLowerCase()
          );
          if (!target) throw new Error(`Target mailbox folder not found: ${folderPath}`);
          foldersToScan = [target];
        } else {
          foldersToScan = allFolders.filter((f) => isStandardFolder(f));
          if (!foldersToScan.some((f) => isInboxFolder(f))) {
            const inbox = allFolders.find((f) => isInboxFolder(f));
            if (inbox) foldersToScan.unshift(inbox);
          }
        }

        for (const folder of foldersToScan) {
          const lock = await client.getMailboxLock(folder.path);
          try {
            if (!client.mailbox || client.mailbox.uidValidity === undefined || client.mailbox.uidValidity === null) {
              throw new Error('Mailbox UIDVALIDITY unavailable');
            }
            const uidValidity = BigInt(client.mailbox.uidValidity);
            if (uidValidity < 1n || uidValidity > 4_294_967_295n) {
              throw new Error('Invalid mailbox UIDVALIDITY');
            }
            const mb = client.mailbox as { highestModseq?: bigint; highestModSeq?: bigint };
            const highestModSeq = parseSafeModSeq(mb.highestModseq ?? mb.highestModSeq);
            const folderState = await prisma.selfHostedFolderState.findUnique({
              where: {
                emailAccountId_folderPath: {
                  emailAccountId: account.id,
                  folderPath: folder.path,
                },
              },
            });

            const isInbox = isInboxFolder(folder);
            const isArchive = isArchiveFolder(folder);
            const isJunk = isJunkFolder(folder);
            const isSent = isSentFolder(folder);
            const isDrafts = isDraftsFolder(folder);

            const searchResults = await client.search({ all: true }, { uid: true });
            const serverUids: number[] = Array.isArray(searchResults)
              ? searchResults.map(Number).sort((a: number, b: number) => a - b)
              : [];
            let maxUidInFolder = 0;

            const syncMessageRecord = async (uid: number, queueForRules: boolean) => {
              const fetched = await client.fetchOne(
                String(uid),
                { source: true, uid: true, flags: true, internalDate: true },
                { uid: true }
              );
              if (!fetched || !fetched.source) throw new Error('Mailbox message unavailable');

              const parsed = await parseRawEmail(new Uint8Array(fetched.source));
              const fromAddress = senderAddress(parsed.from);
              const normalizedSubject = (parsed.subject ?? '').trim().toLowerCase();
              const bodyHash = computeBodyFingerprint(parsed.text, parsed.html);
              const fetchedDate = fetched.internalDate instanceof Date
                ? fetched.internalDate
                : fetched.internalDate
                ? new Date(fetched.internalDate)
                : new Date();
              const messageInternalDate: Date = parsed.date ?? fetchedDate;
              const internalDateMs = messageInternalDate.getTime();
              const headerMessageId = parsed.messageId?.trim() ?? null;

              let matchedExisting:
                | (Awaited<ReturnType<typeof prisma.emailMessage.findFirst>> & { id: string })
                | null = null;

              if (headerMessageId) {
                const candidates = await prisma.emailMessage.findMany({
                  where: { emailAccountId: account.id, headerMessageId },
                });
                for (const candidate of candidates) {
                  const sameSender = senderAddress(candidate.fromEmail) === fromAddress;
                  const sameSubject = candidate.subject.trim().toLowerCase() === normalizedSubject;
                  const sameBody = computeBodyFingerprint(candidate.textBody, candidate.htmlBody) === bodyHash;
                  const closeDate = Math.abs(candidate.internalDate.getTime() - internalDateMs) <= 5000;
                  if (sameSender && sameSubject && (sameBody || closeDate)) {
                    matchedExisting = candidate;
                    break;
                  }
                }
              }

              if (!matchedExisting) {
                matchedExisting = await prisma.emailMessage.findUnique({
                  where: {
                    emailAccountId_imapFolder_imapUidValidity_imapUid: {
                      emailAccountId: account.id,
                      imapFolder: folder.path,
                      imapUidValidity: uidValidity,
                      imapUid: BigInt(uid),
                    },
                  },
                });
              }

              const flags = fetched.flags instanceof Set ? fetched.flags : new Set(fetched.flags ?? []);
              const unread = !flags.has('\\Seen');
              const labels = new Set<string>();
              if (isInbox) labels.add('INBOX');
              if (isArchive) labels.delete('INBOX');
              if (isJunk) labels.add('SPAM');
              if (isSent) labels.add('SENT');
              if (isDrafts || flags.has('\\Draft')) labels.add('DRAFT');
              if (unread) labels.add('UNREAD');

              if (matchedExisting) {
                const systemLabels = new Set(['INBOX', 'SPAM', 'SENT', 'DRAFT', 'UNREAD']);
                for (const existingLabel of matchedExisting.labels) {
                  if (!systemLabels.has(existingLabel)) {
                    labels.add(existingLabel);
                  }
                }
                const labelsArray = Array.from(labels);
                await prisma.emailMessage.update({
                  where: { id: matchedExisting.id },
                  data: {
                    imapFolder: folder.path,
                    imapUid: BigInt(uid),
                    imapUidValidity: uidValidity,
                    labels: labelsArray,
                    unread,
                    archived: isArchive || !isInbox,
                  },
                });
                return;
              }

              const threadId = await resolveSelfHostedThreadId({
                prisma,
                userId: account.userId,
                accountId: account.id,
                inReplyTo: parsed.inReplyTo,
                references: parsed.references,
              });
              const messageId = randomUUID();
              const sanitizedHtml = parsed.html ? sanitizeEmailHtml(parsed.html) : null;
              const labelsArray = Array.from(labels);

              const created = await prisma.emailMessage.create({
                data: {
                  emailAccountId: account.id,
                  threadId,
                  messageId,
                  fromEmail: fromAddress ?? parsed.from,
                  fromName: parsed.from,
                  toEmail: parsed.to,
                  ccEmail: parsed.cc ?? null,
                  headerMessageId,
                  inReplyTo: parsed.inReplyTo ?? null,
                  references: parsed.references ?? null,
                  subject: parsed.subject,
                  snippet: parsed.text.slice(0, 240),
                  textBody: parsed.text,
                  htmlBody: sanitizedHtml,
                  attachmentNames: parsed.attachments.map((a) => a.name).filter(Boolean),
                  mimeTypes: parsed.attachments.map((a) => a.contentType),
                  labels: labelsArray,
                  unread,
                  archived: isArchive || !isInbox,
                  internalDate: messageInternalDate,
                  imapFolder: folder.path,
                  imapUid: BigInt(uid),
                  imapUidValidity: uidValidity,
                },
              });

              if (queueForRules && isInbox) {
                newInboxMessagesToRunRules.push({
                  id: messageId,
                  threadId,
                  snippet: parsed.text.slice(0, 240),
                  internalDate: created.internalDate,
                  labelIds: labelsArray,
                  headers: {
                    from: parsed.from,
                    to: parsed.to,
                    ...(parsed.cc ? { cc: parsed.cc } : {}),
                    subject: parsed.subject,
                    date: created.internalDate.toISOString(),
                    ...(headerMessageId ? { messageId: headerMessageId } : {}),
                    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
                    ...(parsed.references ? { references: parsed.references } : {}),
                  },
                  textPlain: parsed.text,
                  ...(sanitizedHtml ? { textHtml: sanitizedHtml } : {}),
                  mimeTypes: created.mimeTypes,
                  attachmentNames: created.attachmentNames,
                  hasAttachments: created.attachmentNames.length > 0,
                });
              }
            };

            if (mode === 'bootstrap') {
              for (const uid of serverUids) {
                if (uid > maxUidInFolder) maxUidInFolder = uid;
                await syncMessageRecord(uid, false);
              }

              await prisma.selfHostedFolderState.upsert({
                where: {
                  emailAccountId_folderPath: {
                    emailAccountId: account.id,
                    folderPath: folder.path,
                  },
                },
                create: {
                  emailAccountId: account.id,
                  folderPath: folder.path,
                  uidValidity,
                  lastSyncedUid: BigInt(maxUidInFolder),
                  highestModSeq,
                  specialUse: typeof folder.specialUse === 'string' ? folder.specialUse : null,
                  lastScanCompletedAt: new Date(),
                },
                update: {
                  uidValidity,
                  lastSyncedUid: BigInt(maxUidInFolder),
                  highestModSeq,
                  specialUse: typeof folder.specialUse === 'string' ? folder.specialUse : null,
                  lastScanCompletedAt: new Date(),
                },
              });
            } else {
              const isUidValidityReset = Boolean(folderState && folderState.uidValidity !== uidValidity);

              if (isUidValidityReset) {
                for (const uid of serverUids) {
                  if (uid > maxUidInFolder) maxUidInFolder = uid;
                  await syncMessageRecord(uid, true);
                }
              } else {
                const lastSyncedUid = folderState ? Number(folderState.lastSyncedUid) : 0;
                maxUidInFolder = lastSyncedUid;
                const newUids = serverUids.filter((u: number) => u > lastSyncedUid);
                const existingUids = serverUids.filter((u: number) => u <= lastSyncedUid);

                for (const uid of newUids) {
                  if (uid > maxUidInFolder) maxUidInFolder = uid;
                  await syncMessageRecord(uid, true);
                }

                const cachedInFolder = await prisma.emailMessage.findMany({
                  where: {
                    emailAccountId: account.id,
                    imapFolder: folder.path,
                    imapUidValidity: uidValidity,
                  },
                  select: {
                    id: true,
                    messageId: true,
                    imapUid: true,
                    labels: true,
                    unread: true,
                  },
                });

                for (const uid of existingUids) {
                  const cached = cachedInFolder.find((c) => c.imapUid === BigInt(uid));
                  if (cached) {
                    try {
                      const fetched = await client.fetchOne(
                        String(uid),
                        { flags: true, uid: true },
                        { uid: true }
                      );
                      if (fetched && fetched.flags) {
                        const isSeen = fetched.flags.has('\\Seen');
                        const isUnread = !isSeen;
                        let newLabels = [...cached.labels];
                        if (isUnread && !newLabels.includes('UNREAD')) newLabels.push('UNREAD');
                        if (!isUnread && newLabels.includes('UNREAD')) newLabels = newLabels.filter((l) => l !== 'UNREAD');
                        if (fetched.flags.has('\\Draft') && !newLabels.includes('DRAFT')) newLabels.push('DRAFT');
                        if (!fetched.flags.has('\\Draft') && newLabels.includes('DRAFT')) newLabels = newLabels.filter((l) => l !== 'DRAFT');
                        if (isUnread !== cached.unread || newLabels.length !== cached.labels.length) {
                          await prisma.emailMessage.update({
                            where: { id: cached.id },
                            data: { unread: isUnread, labels: newLabels },
                          });
                        }
                      }
                    } catch {
                      // Flag reconciliation per message is best-effort
                    }
                  }
                }

                const serverUidSet = new Set(serverUids);
                for (const cached of cachedInFolder) {
                  if (cached.imapUid !== null && !serverUidSet.has(Number(cached.imapUid))) {
                    pendingVanished.push({
                      id: cached.id,
                      messageId: cached.messageId,
                      labels: cached.labels,
                      folderPath: folder.path,
                      uidValidity,
                    });
                  }
                }
              }

              await prisma.selfHostedFolderState.upsert({
                where: {
                  emailAccountId_folderPath: {
                    emailAccountId: account.id,
                    folderPath: folder.path,
                  },
                },
                create: {
                  emailAccountId: account.id,
                  folderPath: folder.path,
                  uidValidity,
                  lastSyncedUid: BigInt(maxUidInFolder),
                  highestModSeq,
                  specialUse: typeof folder.specialUse === 'string' ? folder.specialUse : null,
                  lastScanCompletedAt: new Date(),
                },
                update: {
                  uidValidity,
                  lastSyncedUid: BigInt(maxUidInFolder),
                  highestModSeq,
                  specialUse: typeof folder.specialUse === 'string' ? folder.specialUse : null,
                  lastScanCompletedAt: new Date(),
                },
              });
            }
          } finally {
            lock.release();
          }
        }

        // Reconcile vanished UIDs only after all scanned folders have processed moves and UIDVALIDITY updates.
        for (const item of pendingVanished) {
          const current = await prisma.emailMessage.findUnique({
            where: { id: item.id },
            select: { imapFolder: true, imapUidValidity: true },
          });
          if (!current || current.imapFolder !== item.folderPath || current.imapUidValidity !== item.uidValidity) {
            continue;
          }

          const executedRuleCount = await prisma.executedRule.count({
            where: { emailAccountId: account.id, messageId: item.messageId },
          });
          if (executedRuleCount > 0) {
            await prisma.emailMessage.update({
              where: { id: item.id },
              data: {
                labels: item.labels.filter((l) => l !== 'INBOX'),
                archived: true,
                imapFolder: null,
                imapUid: null,
                imapUidValidity: null,
              },
            });
          } else {
            await prisma.emailMessage.delete({ where: { id: item.id } });
          }
        }

        if (mode === 'bootstrap') {
          await prisma.emailAccount.update({
            where: { id: account.id },
            data: { initialSyncStatus: 'COMPLETED' },
          });
        }
      }
    );
  } catch (error) {
    if (mode === 'bootstrap') {
      await prisma.emailAccount.updateMany({
        where: { id: account.id },
        data: { initialSyncStatus: 'FAILED' },
      });
    }
    throw error;
  }

  if (newInboxMessagesToRunRules.length > 0) {
    const provider = new SelfHostedMailProvider(prisma, account.id, { env, createClient });
    const executor = runRulesFn ?? runRules;
    for (const message of newInboxMessagesToRunRules) {
      await executor({ prisma, provider, emailAccountId: account.id, message, model });
    }
  }
}
