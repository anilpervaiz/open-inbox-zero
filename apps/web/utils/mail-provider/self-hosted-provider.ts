import { randomUUID } from 'node:crypto';
import type { ExecutedAction, Prisma, PrismaClient } from '@prisma/client';
import type { ImapFlow } from 'imapflow';
import { formatForwardMessage, type ForwardInput } from './forward';
import { fetchSelfHostedRawMessage, withSelfHostedImapClient } from './self-hosted-imap';
import { listSelfHostedCachedThreads, readSelfHostedMessage, readSelfHostedThread } from './self-hosted-message';
import { resolveSelfHostedThreadId } from './self-hosted-threading';
import { senderAddress } from '../rule/static-from-risk';
import type { EmailProvider, ParsedMessage } from './types';

const MAX_IMAP_UID = 4_294_967_295n;

type SelfHostedMessageSnapshot = {
  messageId: string;
  archived: boolean;
  unread: boolean;
  labels: string[];
  imapFolder: string;
  imapUid: string;
  imapUidValidity: string;
};

export type SelfHostedUndoSnapshot = {
  provider: 'selfhosted';
  threadId: string;
  messages: SelfHostedMessageSnapshot[];
};

function toImapKeyword(labelName: string): { label: string; keyword: string } {
  const label = labelName.trim();
  if (!label || label.length > 64 || !/^[A-Za-z0-9._ -]+$/.test(label)) {
    throw new Error('Invalid label name');
  }
  const keyword = label.replace(/\s+/g, '_');
  if (!keyword) throw new Error('Invalid label name');
  return { label, keyword };
}

function readSnapshot(value: unknown, threadId: string): SelfHostedUndoSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('provider' in value) ||
    value.provider !== 'selfhosted' ||
    !('threadId' in value) ||
    value.threadId !== threadId ||
    !('messages' in value) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error('Missing undo snapshot');
  }
  const messages: SelfHostedMessageSnapshot[] = value.messages.map((item: unknown) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('messageId' in item) ||
      typeof item.messageId !== 'string' ||
      !('archived' in item) ||
      typeof item.archived !== 'boolean' ||
      !('unread' in item) ||
      typeof item.unread !== 'boolean' ||
      !('labels' in item) ||
      !Array.isArray(item.labels) ||
      !item.labels.every((l) => typeof l === 'string') ||
      !('imapFolder' in item) ||
      typeof item.imapFolder !== 'string' ||
      !('imapUid' in item) ||
      typeof item.imapUid !== 'string' ||
      !('imapUidValidity' in item) ||
      typeof item.imapUidValidity !== 'string'
    ) {
      throw new Error('Invalid undo snapshot');
    }
    return {
      messageId: item.messageId,
      archived: item.archived,
      unread: item.unread,
      labels: item.labels,
      imapFolder: item.imapFolder,
      imapUid: item.imapUid,
      imapUidValidity: item.imapUidValidity,
    };
  });
  return { provider: 'selfhosted', threadId, messages };
}

async function resolveSpecialFolder(
  client: ImapFlow,
  role: 'archive' | 'junk' | 'drafts' | 'sent' | 'inbox'
): Promise<string> {
  const folders = await client.list({ listOnly: true });
  if (role === 'inbox') {
    const inbox = folders.find(
      (f) => f.path.toUpperCase() === 'INBOX' || f.path.split(/[./\\]/).pop()?.toUpperCase() === 'INBOX'
    );
    return inbox ? inbox.path : 'INBOX';
  }
  const specialMap: Record<string, string> = {
    archive: '\\archive',
    junk: '\\junk',
    drafts: '\\drafts',
    sent: '\\sent',
  };
  const targetSpecial = specialMap[role];
  const bySpecial = folders.find((f) => f.specialUse && f.specialUse.toLowerCase() === targetSpecial);
  if (bySpecial) return bySpecial.path;

  const fallbacks: Record<string, string[]> = {
    archive: ['archive', 'archives'],
    junk: ['junk', 'spam', 'junk email'],
    drafts: ['drafts', 'draft'],
    sent: ['sent', 'sent messages', 'sent items'],
  };
  const names = fallbacks[role] ?? [];
  const byName = folders.find((f) => {
    const lower = f.path.toLowerCase();
    const lastPart = lower.split(/[./\\]/).pop() ?? '';
    return names.includes(lower) || names.includes(lastPart);
  });
  if (byName) return byName.path;

  throw new Error(`Target mailbox folder for ${role} not found`);
}

function validateEmailRecipients(to: string, cc?: string): void {
  if (to.includes('\r') || to.includes('\n')) {
    throw new Error('Invalid email recipient header: newline detected');
  }
  const toAddresses = to.split(',').map((s) => s.trim()).filter(Boolean);
  if (!toAddresses.length) throw new Error('Recipient address is required');
  for (const addr of toAddresses) {
    if (!senderAddress(addr)) {
      throw new Error(`Invalid recipient address: ${addr}`);
    }
  }
  if (cc) {
    if (cc.includes('\r') || cc.includes('\n')) {
      throw new Error('Invalid email recipient header: newline detected');
    }
    const ccAddresses = cc.split(',').map((s) => s.trim()).filter(Boolean);
    for (const addr of ccAddresses) {
      if (!senderAddress(addr)) {
        throw new Error(`Invalid CC recipient address: ${addr}`);
      }
    }
  }
}

function buildDraftMime(input: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
}): Buffer {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${input.body}`, 'utf-8');
}

async function moveMessageInImap(
  client: ImapFlow,
  row: { id: string; messageId: string; imapFolder: string; imapUid: bigint; imapUidValidity: bigint; headerMessageId: string | null },
  destFolder: string
): Promise<{ newFolder: string; newUid: bigint; newUidValidity: bigint }> {
  if (row.imapFolder.toLowerCase() === destFolder.toLowerCase()) {
    return { newFolder: row.imapFolder, newUid: row.imapUid, newUidValidity: row.imapUidValidity };
  }
  const sourceLock = await client.getMailboxLock(row.imapFolder);
  let moveResult: { uidValidity?: bigint; uidMap?: Map<number, number> } | false = false;
  try {
    if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(row.imapUidValidity)) {
      throw new Error('Mailbox location changed');
    }
    moveResult = await client.messageMove(Number(row.imapUid), destFolder, { uid: true });
  } finally {
    sourceLock.release();
  }
  if (!moveResult) throw new Error('Failed to move message');

  let newUid: bigint | undefined;
  let newUidValidity: bigint | undefined;

  if (moveResult.uidMap && moveResult.uidMap.has(Number(row.imapUid))) {
    newUid = BigInt(moveResult.uidMap.get(Number(row.imapUid))!);
  }
  if (moveResult.uidValidity) {
    newUidValidity = BigInt(moveResult.uidValidity);
  }

  if (!newUid || !newUidValidity) {
    const destLock = await client.getMailboxLock(destFolder);
    try {
      if (!newUidValidity && client.mailbox && client.mailbox.uidValidity) {
        newUidValidity = BigInt(client.mailbox.uidValidity);
      }
      if (!newUid && row.headerMessageId) {
        const searchResult = await client.search({ header: { 'message-id': row.headerMessageId } }, { uid: true });
        if (searchResult && searchResult.length > 0) {
          newUid = BigInt(searchResult[searchResult.length - 1]);
        }
      }
    } finally {
      destLock.release();
    }
  }

  if (!newUid || !newUidValidity) {
    throw new Error('Failed to determine destination message UID');
  }

  return { newFolder: destFolder, newUid, newUidValidity };
}

export class SelfHostedMailProvider implements EmailProvider {
  readonly providerName = 'selfhosted' as const;

  constructor(
    private readonly prisma: PrismaClient,
    readonly emailAccountId: string,
    private readonly options?: {
      env?: Record<string, string | undefined>;
      createClient?: Parameters<typeof withSelfHostedImapClient>[0]['createClient'];
    }
  ) {
    if (!emailAccountId || !emailAccountId.trim()) {
      throw new Error('Provider account ID is required');
    }
  }

  private async getOwnerAccount() {
    const account = await this.prisma.emailAccount.findFirst({
      where: { id: this.emailAccountId, provider: 'selfhosted' },
      select: { id: true, userId: true, email: true },
    });
    if (!account) throw new Error('Self-hosted account not found');
    return account;
  }

  private async getValidTargetMessages(account: { userId: string }, threadId: string) {
    const rows = await this.prisma.emailMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        threadId,
        emailAccount: { userId: account.userId, provider: 'selfhosted' },
      },
      orderBy: { internalDate: 'asc' },
    });
    if (!rows.length) throw new Error('Thread not found');
    for (const row of rows) {
      if (
        !row.imapFolder ||
        row.imapUid === null ||
        row.imapUidValidity === null ||
        row.imapUid < 1n ||
        row.imapUid > MAX_IMAP_UID ||
        row.imapUidValidity < 1n ||
        row.imapUidValidity > MAX_IMAP_UID
      ) {
        throw new Error('Mailbox message location unavailable');
      }
    }
    return rows;
  }

  async listThreads(options: { query?: string; labelIds?: string[]; maxResults?: number }): Promise<{ threadIds: string[] }> {
    const account = await this.getOwnerAccount();
    const threadIds = await listSelfHostedCachedThreads({
      prisma: this.prisma,
      userId: account.userId,
      accountId: account.id,
      ...options,
    });
    return { threadIds };
  }

  async *iterateThreadIds(): AsyncGenerator<string> {
    const account = await this.getOwnerAccount();
    const seen = new Set<string>();
    const batchSize = 200;
    let cursorId: string | undefined;
    while (true) {
      const rows = await this.prisma.emailMessage.findMany({
        where: {
          emailAccountId: account.id,
          emailAccount: { userId: account.userId, provider: 'selfhosted' },
        },
        orderBy: [{ internalDate: 'desc' }, { id: 'desc' }],
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        select: { id: true, threadId: true },
      });
      if (!rows.length) break;
      for (const row of rows) {
        if (!seen.has(row.threadId)) {
          seen.add(row.threadId);
          yield row.threadId;
        }
      }
      if (rows.length < batchSize) break;
      cursorId = rows[rows.length - 1].id;
    }
  }

  async getThread(threadId: string): Promise<{ id: string; messages: ParsedMessage[] }> {
    const account = await this.getOwnerAccount();
    return readSelfHostedThread({
      prisma: this.prisma,
      userId: account.userId,
      accountId: account.id,
      threadId,
      env: this.options?.env,
      createClient: this.options?.createClient,
    });
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const account = await this.getOwnerAccount();
    return readSelfHostedMessage({
      prisma: this.prisma,
      userId: account.userId,
      accountId: account.id,
      messageId,
      env: this.options?.env,
      createClient: this.options?.createClient,
    });
  }

  async getRawMessage(messageId: string): Promise<Uint8Array> {
    const account = await this.getOwnerAccount();
    return fetchSelfHostedRawMessage({
      prisma: this.prisma,
      userId: account.userId,
      accountId: account.id,
      messageId,
      env: this.options?.env,
      createClient: this.options?.createClient,
    });
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return Boolean(message.headers.inReplyTo || message.headers.references);
  }

  async captureUndoSnapshot(threadId: string): Promise<SelfHostedUndoSnapshot> {
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);
    const messages = rows.map((row) => ({
      messageId: row.messageId,
      archived: row.archived,
      unread: row.unread,
      labels: row.labels,
      imapFolder: row.imapFolder!,
      imapUid: row.imapUid!.toString(),
      imapUidValidity: row.imapUidValidity!.toString(),
    }));
    return {
      provider: 'selfhosted',
      threadId,
      messages,
    };
  }

  async archiveThread(threadId: string): Promise<void> {
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        const destFolder = await resolveSpecialFolder(client, 'archive');
        for (const row of rows) {
          const { newFolder, newUid, newUidValidity } = await moveMessageInImap(
            client,
            { id: row.id, messageId: row.messageId, imapFolder: row.imapFolder!, imapUid: row.imapUid!, imapUidValidity: row.imapUidValidity!, headerMessageId: row.headerMessageId },
            destFolder
          );
          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              imapFolder: newFolder,
              imapUid: newUid,
              imapUidValidity: newUidValidity,
              archived: true,
              labels: row.labels.filter((label) => label !== 'INBOX'),
            },
          });
        }
      }
    );
  }

  async markSpam(threadId: string): Promise<void> {
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        const destFolder = await resolveSpecialFolder(client, 'junk');
        for (const row of rows) {
          const { newFolder, newUid, newUidValidity } = await moveMessageInImap(
            client,
            { id: row.id, messageId: row.messageId, imapFolder: row.imapFolder!, imapUid: row.imapUid!, imapUidValidity: row.imapUidValidity!, headerMessageId: row.headerMessageId },
            destFolder
          );
          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              imapFolder: newFolder,
              imapUid: newUid,
              imapUidValidity: newUidValidity,
              archived: true,
              labels: [...new Set([...row.labels.filter((label) => label !== 'INBOX'), 'SPAM'])],
            },
          });
        }
      }
    );
  }

  async restoreArchive(threadId: string, snapshotValue: Prisma.JsonValue): Promise<void> {
    const account = await this.getOwnerAccount();
    const snapshot = readSnapshot(snapshotValue, threadId);
    const rows = await this.getValidTargetMessages(account, threadId);

    if (snapshot.messages.some((original) => !rows.some((row) => row.messageId === original.messageId))) {
      throw new Error('Cannot restore: an original message is missing');
    }

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        for (const row of rows) {
          const original = snapshot.messages.find((item) => item.messageId === row.messageId);
          if (!original || original.archived || !row.archived) continue;

          let newFolder = row.imapFolder!;
          let newUid = row.imapUid!;
          let newUidValidity = row.imapUidValidity!;

          if (row.imapFolder !== original.imapFolder) {
            const moveRes = await moveMessageInImap(
              client,
              { id: row.id, messageId: row.messageId, imapFolder: row.imapFolder!, imapUid: row.imapUid!, imapUidValidity: row.imapUidValidity!, headerMessageId: row.headerMessageId },
              original.imapFolder
            );
            newFolder = moveRes.newFolder;
            newUid = moveRes.newUid;
            newUidValidity = moveRes.newUidValidity;
          }

          const labels = original.labels.includes('INBOX')
            ? [...new Set([...row.labels, 'INBOX'])]
            : row.labels;

          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              imapFolder: newFolder,
              imapUid: newUid,
              imapUidValidity: newUidValidity,
              archived: false,
              labels,
            },
          });
        }
      }
    );
  }

  async markRead(threadId: string, read: boolean): Promise<void> {
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        for (const row of rows) {
          const lock = await client.getMailboxLock(row.imapFolder!);
          try {
            if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(row.imapUidValidity!)) {
              throw new Error('Mailbox location changed');
            }
            if (read) {
              await client.messageFlagsAdd(Number(row.imapUid!), ['\\Seen'], { uid: true });
            } else {
              await client.messageFlagsRemove(Number(row.imapUid!), ['\\Seen'], { uid: true });
            }
          } finally {
            lock.release();
          }

          const labels = read
            ? row.labels.filter((l) => l !== 'UNREAD')
            : [...new Set([...row.labels, 'UNREAD'])];

          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              unread: !read,
              labels,
            },
          });
        }
      }
    );
  }

  async addLabel(threadId: string, labelName: string): Promise<{ labelId: string }> {
    const { label, keyword } = toImapKeyword(labelName);
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        for (const row of rows) {
          const lock = await client.getMailboxLock(row.imapFolder!);
          try {
            if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(row.imapUidValidity!)) {
              throw new Error('Mailbox location changed');
            }
            await client.messageFlagsAdd(Number(row.imapUid!), [keyword], { uid: true });
          } finally {
            lock.release();
          }

          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              labels: [...new Set([...row.labels, label])],
            },
          });
        }
      }
    );
    return { labelId: label };
  }

  async removeLabel(threadId: string, labelName: string): Promise<void> {
    const { label, keyword } = toImapKeyword(labelName);
    const account = await this.getOwnerAccount();
    const rows = await this.getValidTargetMessages(account, threadId);

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        for (const row of rows) {
          const lock = await client.getMailboxLock(row.imapFolder!);
          try {
            if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(row.imapUidValidity!)) {
              throw new Error('Mailbox location changed');
            }
            await client.messageFlagsRemove(Number(row.imapUid!), [keyword], { uid: true });
          } finally {
            lock.release();
          }

          await this.prisma.emailMessage.update({
            where: { id: row.id },
            data: {
              labels: row.labels.filter((l) => l !== label),
            },
          });
        }
      }
    );
  }

  async createDraft(input: {
    threadId?: string;
    to: string;
    cc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<{ draftId: string }> {
    validateEmailRecipients(input.to, input.cc);
    if (input.subject.includes('\r') || input.subject.includes('\n')) {
      throw new Error('Subject cannot contain newlines');
    }
    const account = await this.getOwnerAccount();
    const threadId =
      input.threadId ??
      (await resolveSelfHostedThreadId({
        prisma: this.prisma,
        userId: account.userId,
        accountId: this.emailAccountId,
        inReplyTo: input.inReplyTo,
      }));

    const domain = account.email.split('@')[1] || 'localhost';
    const headerMessageId = `<${randomUUID()}@${domain}>`;
    const mime = buildDraftMime({
      from: account.email,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      messageId: headerMessageId,
      inReplyTo: input.inReplyTo,
    });

    const { destFolder, uid, uidValidity } = await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        const draftsFolder = await resolveSpecialFolder(client, 'drafts');
        const appendResult = await client.append(draftsFolder, mime, ['\\Draft', '\\Seen']);
        if (!appendResult) throw new Error('Failed to append draft');

        let destUid: bigint | undefined = appendResult.uid ? BigInt(appendResult.uid) : undefined;
        let destUidValidity: bigint | undefined = appendResult.uidValidity ? BigInt(appendResult.uidValidity) : undefined;

        if (!destUid || !destUidValidity) {
          const draftLock = await client.getMailboxLock(draftsFolder);
          try {
            if (!destUidValidity && client.mailbox && client.mailbox.uidValidity) {
              destUidValidity = BigInt(client.mailbox.uidValidity);
            }
            if (!destUid) {
              const searchResult = await client.search({ header: { 'message-id': headerMessageId } }, { uid: true });
              if (searchResult && searchResult.length > 0) {
                destUid = BigInt(searchResult[searchResult.length - 1]);
              }
            }
          } finally {
            draftLock.release();
          }
        }

        if (!destUid || !destUidValidity) {
          throw new Error('Failed to determine draft mailbox location');
        }

        return { destFolder: draftsFolder, uid: destUid, uidValidity: destUidValidity };
      }
    );

    const messageId = randomUUID();
    await this.prisma.emailMessage.create({
      data: {
        emailAccountId: this.emailAccountId,
        threadId,
        messageId,
        fromEmail: account.email,
        toEmail: input.to,
        ccEmail: input.cc,
        subject: input.subject,
        textBody: input.body,
        snippet: input.body.slice(0, 240),
        headerMessageId,
        inReplyTo: input.inReplyTo,
        internalDate: new Date(),
        labels: ['DRAFT'],
        unread: false,
        archived: false,
        imapFolder: destFolder,
        imapUid: uid,
        imapUidValidity: uidValidity,
      },
    });

    return { draftId: messageId };
  }

  async updateDraft(input: {
    draftId: string;
    threadId: string;
    to: string;
    cc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<{ draftId: string }> {
    validateEmailRecipients(input.to, input.cc);
    if (input.subject.includes('\r') || input.subject.includes('\n')) {
      throw new Error('Subject cannot contain newlines');
    }
    const account = await this.getOwnerAccount();
    const oldDraft = await this.prisma.emailMessage.findFirst({
      where: {
        emailAccountId: this.emailAccountId,
        messageId: input.draftId,
        threadId: input.threadId,
        labels: { has: 'DRAFT' },
        emailAccount: { userId: account.userId, provider: 'selfhosted' },
      },
    });
    if (!oldDraft) throw new Error('Draft is not in this thread');

    if (
      !oldDraft.imapFolder ||
      oldDraft.imapUid === null ||
      oldDraft.imapUidValidity === null ||
      oldDraft.imapUid < 1n ||
      oldDraft.imapUid > MAX_IMAP_UID ||
      oldDraft.imapUidValidity < 1n ||
      oldDraft.imapUidValidity > MAX_IMAP_UID
    ) {
      throw new Error('Draft mailbox location unavailable');
    }

    const domain = account.email.split('@')[1] || 'localhost';
    const headerMessageId = `<${randomUUID()}@${domain}>`;
    const mime = buildDraftMime({
      from: account.email,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      messageId: headerMessageId,
      inReplyTo: input.inReplyTo,
    });

    const { destFolder, uid, uidValidity } = await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        const draftsFolder = await resolveSpecialFolder(client, 'drafts');
        const appendResult = await client.append(draftsFolder, mime, ['\\Draft', '\\Seen']);
        if (!appendResult) throw new Error('Failed to append draft');

        let destUid: bigint | undefined = appendResult.uid ? BigInt(appendResult.uid) : undefined;
        let destUidValidity: bigint | undefined = appendResult.uidValidity ? BigInt(appendResult.uidValidity) : undefined;

        if (!destUid || !destUidValidity) {
          const draftLock = await client.getMailboxLock(draftsFolder);
          try {
            if (!destUidValidity && client.mailbox && client.mailbox.uidValidity) {
              destUidValidity = BigInt(client.mailbox.uidValidity);
            }
            if (!destUid) {
              const searchResult = await client.search({ header: { 'message-id': headerMessageId } }, { uid: true });
              if (searchResult && searchResult.length > 0) {
                destUid = BigInt(searchResult[searchResult.length - 1]);
              }
            }
          } finally {
            draftLock.release();
          }
        }

        if (!destUid || !destUidValidity) {
          throw new Error('Failed to determine draft mailbox location');
        }

        const oldLock = await client.getMailboxLock(oldDraft.imapFolder!);
        try {
          if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(oldDraft.imapUidValidity!)) {
            throw new Error('Mailbox location changed');
          }
          await client.messageDelete(Number(oldDraft.imapUid!), { uid: true });
        } finally {
          oldLock.release();
        }

        return { destFolder: draftsFolder, uid: destUid, uidValidity: destUidValidity };
      }
    );

    await this.prisma.emailMessage.update({
      where: { id: oldDraft.id },
      data: {
        toEmail: input.to,
        ccEmail: input.cc,
        subject: input.subject,
        textBody: input.body,
        snippet: input.body.slice(0, 240),
        headerMessageId,
        inReplyTo: input.inReplyTo,
        internalDate: new Date(),
        imapFolder: destFolder,
        imapUid: uid,
        imapUidValidity: uidValidity,
      },
    });

    return { draftId: input.draftId };
  }

  async createForwardDraft(input: ForwardInput): Promise<{ draftId: string; draftThreadId: string }> {
    const source = await this.getMessage(input.messageId);
    if (source.threadId !== input.threadId) {
      throw new Error('Forward message is not in account and thread');
    }
    const formatted = formatForwardMessage(source, input.comment);
    const { draftId } = await this.createDraft({
      threadId: input.threadId,
      to: input.to,
      cc: input.cc,
      subject: formatted.subject,
      body: formatted.body,
    });
    return { draftId, draftThreadId: input.threadId };
  }

  async undoAction(action: ExecutedAction, threadId: string): Promise<void> {
    const account = await this.getOwnerAccount();
    const saved = await this.prisma.executedAction.findFirst({
      where: {
        id: action.id,
        executedRule: {
          emailAccountId: this.emailAccountId,
          threadId,
          emailAccount: { userId: account.userId, provider: 'selfhosted' },
        },
      },
    });
    if (!saved || !(saved.status === 'COMPLETED' || (saved.status === 'FAILED' && saved.executionStartedAt && saved.undoSnapshot))) {
      throw new Error('Reversible action not found for this account and thread');
    }

    if (saved.type === 'ARCHIVE') {
      await this.restoreArchive(threadId, saved.undoSnapshot);
      return;
    }

    if (saved.type === 'DRAFT_EMAIL') {
      if (!saved.draftId) throw new Error('Draft ID is missing');
      const draft = await this.prisma.emailMessage.findFirst({
        where: {
          emailAccountId: this.emailAccountId,
          messageId: saved.draftId,
          threadId: saved.draftThreadId ?? threadId,
          labels: { has: 'DRAFT' },
          emailAccount: { userId: account.userId, provider: 'selfhosted' },
        },
      });
      if (!draft) throw new Error('Cannot undo: the message is no longer a draft in this thread');

      if (draft.imapFolder && draft.imapUid !== null && draft.imapUidValidity !== null) {
        await withSelfHostedImapClient(
          { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
          async (client) => {
            const lock = await client.getMailboxLock(draft.imapFolder!);
            try {
              if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(draft.imapUidValidity!)) {
                throw new Error('Mailbox location changed');
              }
              await client.messageDelete(Number(draft.imapUid!), { uid: true });
            } finally {
              lock.release();
            }
          }
        );
      }
      await this.prisma.emailMessage.delete({ where: { id: draft.id } });
      return;
    }

    if (!['ARCHIVE', 'LABEL', 'MARK_SEEN', 'MARK_SPAM', 'DRAFT_EMAIL'].includes(saved.type)) {
      throw new Error(`Action ${saved.type} cannot be undone`);
    }

    const snapshot = readSnapshot(saved.undoSnapshot, threadId);
    const rows = await this.getValidTargetMessages(account, threadId);
    if (snapshot.messages.some((original) => !rows.some((message) => message.messageId === original.messageId))) {
      throw new Error('Cannot undo: an original message is missing');
    }

    await withSelfHostedImapClient(
      { prisma: this.prisma, userId: account.userId, accountId: this.emailAccountId, env: this.options?.env, createClient: this.options?.createClient },
      async (client) => {
        for (const message of rows) {
          const previous = snapshot.messages.find((item) => item.messageId === message.messageId);
          if (!previous) continue;

          if (saved.type === 'MARK_SPAM' && message.labels.includes('SPAM')) {
            let newFolder = message.imapFolder!;
            let newUid = message.imapUid!;
            let newUidValidity = message.imapUidValidity!;

            if (message.imapFolder !== previous.imapFolder) {
              const moveRes = await moveMessageInImap(
                client,
                { id: message.id, messageId: message.messageId, imapFolder: message.imapFolder!, imapUid: message.imapUid!, imapUidValidity: message.imapUidValidity!, headerMessageId: message.headerMessageId },
                previous.imapFolder
              );
              newFolder = moveRes.newFolder;
              newUid = moveRes.newUid;
              newUidValidity = moveRes.newUidValidity;
            }

            const labels = message.labels.filter((label) => label !== 'SPAM' || previous.labels.includes('SPAM'));
            if (previous.labels.includes('INBOX') && !labels.includes('INBOX')) labels.push('INBOX');

            await this.prisma.emailMessage.update({
              where: { id: message.id },
              data: {
                imapFolder: newFolder,
                imapUid: newUid,
                imapUidValidity: newUidValidity,
                archived: previous.archived,
                labels,
              },
            });
          } else if (saved.type === 'LABEL' && saved.label) {
            const { label, keyword } = toImapKeyword(saved.label);
            const lock = await client.getMailboxLock(message.imapFolder!);
            try {
              if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(message.imapUidValidity!)) {
                throw new Error('Mailbox location changed');
              }
              if (saved.labelOperation === 'REMOVE' && previous.labels.includes(label) && !message.labels.includes(label)) {
                await client.messageFlagsAdd(Number(message.imapUid!), [keyword], { uid: true });
                await this.prisma.emailMessage.update({
                  where: { id: message.id },
                  data: { labels: [...message.labels, label] },
                });
              } else if (saved.labelOperation !== 'REMOVE' && !previous.labels.includes(label) && message.labels.includes(label)) {
                await client.messageFlagsRemove(Number(message.imapUid!), [keyword], { uid: true });
                await this.prisma.emailMessage.update({
                  where: { id: message.id },
                  data: { labels: message.labels.filter((item) => item !== label) },
                });
              }
            } finally {
              lock.release();
            }
          } else if (saved.type === 'MARK_SEEN' && previous.unread && !message.unread) {
            const lock = await client.getMailboxLock(message.imapFolder!);
            try {
              if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== BigInt(message.imapUidValidity!)) {
                throw new Error('Mailbox location changed');
              }
              await client.messageFlagsRemove(Number(message.imapUid!), ['\\Seen'], { uid: true });
            } finally {
              lock.release();
            }

            const labels = previous.labels.includes('UNREAD')
              ? [...new Set([...message.labels, 'UNREAD'])]
              : message.labels;

            await this.prisma.emailMessage.update({
              where: { id: message.id },
              data: { unread: true, labels },
            });
          }
        }
      }
    );
  }

  async sendEmail(input: {
    threadId?: string;
    to: string;
    cc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string }> {
    void input;
    if (process.env.PILOT_MODE !== 'false') throw new Error('Automatic sending and forwarding are disabled in pilot mode');
    throw new Error('Self-hosted SMTP sending is not enabled');
  }

  async forwardEmail(input: ForwardInput): Promise<{ messageId: string }> {
    void input;
    if (process.env.PILOT_MODE !== 'false') throw new Error('Automatic sending and forwarding are disabled in pilot mode');
    throw new Error('Self-hosted SMTP sending is not enabled');
  }
}
