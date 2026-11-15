import type { PrismaClient } from '@prisma/client';
import { readFile, stat } from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import { getSelfHostedCredential } from './self-hosted-credentials';

type ImapOptions = ConstructorParameters<typeof ImapFlow>[0];
type MailboxConnection = ImapFlow;
export type ConnectionInput = {
  prisma: PrismaClient;
  userId?: string;
  sessionUserId?: string;
  accountId: string;
  env?: Record<string, string | undefined>;
  createClient?: (options: ImapOptions) => MailboxConnection;
};

export type SelfHostedFolderInfo = {
  path: string;
  specialUse: string | null;
};

/** The destination is server configuration, never a mailbox owner's input. */
function configuredHostname(env: Record<string, string | undefined>): string {
  const host = env.SELF_HOSTED_IMAP_HOST;
  if (!host || host.length > 253 || !host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Self-hosted mail server is not configured');
  return host.toLowerCase();
}

function configuredPort(env: Record<string, string | undefined>): number {
  const raw = env.SELF_HOSTED_IMAP_PORT;
  if (raw === undefined || raw === '') return 993;
  if (!/^\d+$/.test(raw)) throw new Error('Self-hosted mail server is not configured');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Self-hosted mail server is not configured');
  return port;
}

/** Execute one mailbox operation with verified TLS and close on every outcome. */
export async function withSelfHostedImapClient<T>(input: ConnectionInput, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const env = input.env ?? process.env;
  const host = configuredHostname(env);
  const port = configuredPort(env);
  let ca: Buffer | undefined;
  if (env.SELF_HOSTED_TLS_CA_FILE) {
    try {
      const info = await stat(env.SELF_HOSTED_TLS_CA_FILE);
      if (!info.isFile() || info.size < 1 || info.size > 1_048_576) throw new Error('Invalid CA file');
      ca = await readFile(env.SELF_HOSTED_TLS_CA_FILE);
      if (ca.length < 1 || ca.length > 1_048_576 || !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid CA file');
    } catch { throw new Error('Self-hosted mail server CA is unavailable'); }
  }
  const userId = input.userId ?? input.sessionUserId;
  if (!userId) throw new Error('Mailbox user is required');
  const credential = await getSelfHostedCredential({ prisma: input.prisma, userId, accountId: input.accountId });
  const options: ImapOptions = {
    host, port, secure: true, tls: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    auth: { user: credential.username, pass: credential.password }, logger: false,
    disableAutoIdle: true, connectionTimeout: 15_000, greetingTimeout: 15_000,
    socketTimeout: 30_000, maxLineLength: 1_048_576, maxLiteralSize: 20_000_000,
    maxResponseSize: 21_048_576,
  };
  let client: MailboxConnection | undefined;
  try {
    client = (input.createClient ?? (settings => new ImapFlow(settings)))(options);
    // Socket errors can also arrive as events; do not log credential-bearing details.
    client.on('error', () => {});
    await client.connect();
    return await operation(client);
  } catch { throw new Error('Self-hosted mailbox connection failed'); }
  finally { try { client?.close(); } catch { /* Closing must not disclose provider details. */ } }
}

/** Fetch exact MIME only when the saved location still identifies this mailbox. */
export async function fetchSelfHostedRawMessage(input: ConnectionInput & { messageId: string }): Promise<Uint8Array> {
  const userId = input.userId ?? input.sessionUserId;
  if (!userId) throw new Error('Mailbox user is required');
  const row = await input.prisma.emailMessage.findFirst({
    where: { emailAccountId: input.accountId, messageId: input.messageId, emailAccount: { userId, provider: 'selfhosted' } },
    select: { imapFolder: true, imapUid: true, imapUidValidity: true },
  });
  const maxUid = 4_294_967_295n;
  if (!row?.imapFolder || row.imapUid === null || row.imapUidValidity === null || row.imapUid < 1n || row.imapUid > maxUid || row.imapUidValidity < 1n || row.imapUidValidity > maxUid) throw new Error('Mailbox message location unavailable');
  return withSelfHostedImapClient(input, async client => {
    const lock = await client.getMailboxLock(row.imapFolder!);
    try {
      if (!client.mailbox || client.mailbox.uidValidity !== row.imapUidValidity) throw new Error('Mailbox location changed');
      const found = await client.fetchOne(Number(row.imapUid), { uid: true, source: true }, { uid: true });
      if (!found || found.uid !== Number(row.imapUid) || !found.source || !found.source.length || found.source.length > 20_000_000) throw new Error('Mailbox message unavailable');
      return new Uint8Array(found.source);
    } finally { lock.release(); }
  });
}

/** Authenticate and list folders; this does not alter mail or send messages. */
export async function listSelfHostedFolders(input: ConnectionInput): Promise<SelfHostedFolderInfo[]> {
  return withSelfHostedImapClient(input, async client => {
    const folders = await client.list();
    if (folders.length > 1000 || folders.some(folder => !folder.path || folder.path.length > 1024)) throw new Error('Invalid folder listing');
    return folders.map(folder => ({
      path: folder.path,
      specialUse: folder.specialUse ?? null,
    }));
  });
}
