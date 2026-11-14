import type { PrismaClient } from '@prisma/client';
import { readFile, stat } from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import { getSelfHostedCredential } from './self-hosted-credentials';

type ImapOptions = ConstructorParameters<typeof ImapFlow>[0];
type MailboxConnection = ImapFlow;
type ConnectionInput = {
  prisma: PrismaClient; userId: string; accountId: string;
  env?: Record<string, string | undefined>;
  createClient?: (options: ImapOptions) => MailboxConnection;
};

/** The destination is server configuration, never a mailbox owner's input. */
function configuredHostname(env: Record<string, string | undefined>): string {
  const host = env.SELF_HOSTED_IMAP_HOST;
  if (!host || host.length > 253 || !host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('Self-hosted mail server is not configured');
  return host.toLowerCase();
}

/** Execute one mailbox operation with verified TLS and close on every outcome. */
export async function withSelfHostedImapClient<T>(input: ConnectionInput, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const env = input.env ?? process.env;
  const host = configuredHostname(env);
  let ca: Buffer | undefined;
  if (env.SELF_HOSTED_TLS_CA_FILE) {
    try {
      const info = await stat(env.SELF_HOSTED_TLS_CA_FILE);
      if (!info.isFile() || info.size < 1 || info.size > 1_048_576) throw new Error('Invalid CA file');
      ca = await readFile(env.SELF_HOSTED_TLS_CA_FILE);
      if (ca.length < 1 || ca.length > 1_048_576 || !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid CA file');
    } catch { throw new Error('Self-hosted mail server CA is unavailable'); }
  }
  const credential = await getSelfHostedCredential(input);
  const options: ImapOptions = {
    host, port: 993, secure: true, tls: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    auth: { user: credential.username, pass: credential.password }, logger: false,
    disableAutoIdle: true, connectionTimeout: 15_000, greetingTimeout: 15_000,
    socketTimeout: 30_000, maxLineLength: 1_048_576, maxLiteralSize: 1_048_576,
    maxResponseSize: 2_097_152,
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

/** Authenticate and list folders; this does not alter mail or send messages. */
export async function listSelfHostedFolders(input: ConnectionInput): Promise<{ path: string; specialUse: string | null }[]> {
  return withSelfHostedImapClient(input, async client => {
    const folders = await client.list({ listOnly: true });
    if (folders.length > 1000 || folders.some(folder => !folder.path || folder.path.length > 1024)) throw new Error('Invalid folder listing');
    return folders.map(folder => ({ path: folder.path, specialUse: folder.specialUse ?? null }));
  });
}
