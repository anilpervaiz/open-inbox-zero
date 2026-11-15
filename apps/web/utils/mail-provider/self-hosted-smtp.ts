import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { PrismaClient } from '@prisma/client';
import type { ImapFlow } from 'imapflow';
import { parseRawEmail, type RawEmail } from '../../../../packages/mail-core/src/raw-email';
import { getSelfHostedCredential } from './self-hosted-credentials';
import { withSelfHostedImapClient, type ConnectionInput } from './self-hosted-imap';
import { resolveSelfHostedThreadId } from './self-hosted-threading';
import { senderAddress } from '../rule/static-from-risk';

export type SmtpResponse = {
  code: number;
  lines: string[];
  fullText: string;
};

class SmtpRejectionError extends Error {
  public code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'SmtpRejectionError';
    this.code = code;
  }
}

export type SendSelfHostedSmtpInput = {
  prisma: PrismaClient;
  sessionUserId: string;
  emailAccountId: string;
  userInitiated: boolean;
  automated?: boolean;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  from?: string;
  inReplyTo?: string;
  references?: string;
  draftId?: string;
  threadId?: string;
  rfc822MessageId?: string;
  appendToSent?: boolean;
  env?: Record<string, string | undefined>;
  createImapClient?: ConnectionInput['createClient'];
};

export type SendSelfHostedSmtpResult = {
  deliveryId: string;
  rfc822MessageId: string;
  smtpResponse?: string;
  threadId: string;
};

export type ReconcileUncertainDeliveryInput = {
  prisma: PrismaClient;
  sessionUserId: string;
  deliveryId: string;
  env?: Record<string, string | undefined>;
  createImapClient?: ConnectionInput['createClient'];
};

export type ReconcileUncertainDeliveryResult = {
  status: 'COMPLETED' | 'FAILED';
  deliveryId: string;
};

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function configuredSmtpHostname(env: Record<string, string | undefined>): string {
  const host = env.SELF_HOSTED_SMTP_HOST;
  if (!host || host.length > 253 || !host.includes('.')) {
    throw new Error('Self-hosted mail server is not configured');
  }
  const isIp = isIpv4(host);
  if (!isIp) {
    if (host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new Error('Self-hosted mail server is not configured');
    }
  }
  return host.toLowerCase();
}

function configuredSmtpPortAndMode(env: Record<string, string | undefined>): {
  port: number;
  mode: 'implicit' | 'starttls';
} {
  const rawPort = env.SELF_HOSTED_SMTP_PORT;
  const port = rawPort === undefined || rawPort === '' ? 465 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Self-hosted mail server is not configured');
  }

  const explicitMode = env.SELF_HOSTED_SMTP_TLS_MODE?.toLowerCase();
  if (port === 465) {
    if (explicitMode && explicitMode !== 'implicit') {
      throw new Error('Invalid SMTP TLS mode for port 465');
    }
    return { port: 465, mode: 'implicit' };
  }
  if (port === 587) {
    if (explicitMode && explicitMode !== 'starttls') {
      throw new Error('Invalid SMTP TLS mode for port 587');
    }
    return { port: 587, mode: 'starttls' };
  }
  if (explicitMode === 'implicit' || explicitMode === 'starttls') {
    return { port, mode: explicitMode };
  }
  throw new Error('Self-hosted mail server is not configured');
}

async function loadCa(caFilePath?: string): Promise<Buffer | undefined> {
  if (!caFilePath) return undefined;
  try {
    const info = await stat(caFilePath);
    if (!info.isFile() || info.size < 1 || info.size > 1_048_576) throw new Error('Invalid CA file');
    const ca = await readFile(caFilePath);
    if (ca.length < 1 || ca.length > 1_048_576 || !ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Invalid CA file');
    }
    return ca;
  } catch {
    throw new Error('Self-hosted mail server CA is unavailable');
  }
}

function sanitizeError(msg: string): string {
  if (!msg) return 'Unknown error';
  return msg
    .replace(/AUTH\s+[A-Za-z0-9+/=]+/gi, 'AUTH [REDACTED]')
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED]')
    .slice(0, 500);
}

function parseSmtpResponseFromBuffer(buf: string): { response: SmtpResponse; remaining: string } | null {
  let idx = 0;
  const lines: string[] = [];
  let code: number | null = null;
  let isComplete = false;

  while (true) {
    const crlf = buf.indexOf('\r\n', idx);
    if (crlf === -1) break;
    const line = buf.slice(idx, crlf);
    idx = crlf + 2;

    const match = line.match(/^(\d{3})(?:([ -])(.*))?$/);
    if (!match) {
      throw new Error(`Malformed SMTP response: ${line.slice(0, 100)}`);
    }
    const lineCode = Number(match[1]);
    const separator = match[2] ?? ' ';

    if (code === null) {
      code = lineCode;
    } else if (code !== lineCode) {
      throw new Error(`SMTP response code mismatch: expected ${code}, got ${lineCode}`);
    }

    lines.push(line);

    if (separator === ' ') {
      isComplete = true;
      break;
    }
  }

  if (isComplete && code !== null) {
    return {
      response: {
        code,
        lines,
        fullText: lines.join('\r\n'),
      },
      remaining: buf.slice(idx),
    };
  }

  return null;
}

type SmtpWaiter = {
  resolve: (response: SmtpResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

class SmtpSocketSession {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private isTls = false;
  private closed = false;
  private host: string;
  private isIp: boolean;
  private ca?: Buffer;
  private waiters: SmtpWaiter[] = [];

  constructor(options: { host: string; isIp: boolean; ca?: Buffer }) {
    this.host = options.host;
    this.isIp = options.isIp;
    this.ca = options.ca;
  }

  private attachHandlers(sock: net.Socket | tls.TLSSocket) {
    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      if (this.buffer.length > 1_048_576) {
        this.failWaiters(new Error('SMTP response exceeded buffer limit'));
        this.close();
        return;
      }
      this.dispatchWaiters();
    });

    sock.on('error', (err: Error) => {
      this.failWaiters(err);
      this.close();
    });

    sock.on('close', () => {
      this.failWaiters(new Error('Socket closed unexpectedly before SMTP response'));
      this.close();
    });

    sock.on('end', () => {
      this.failWaiters(new Error('Socket ended unexpectedly before SMTP response'));
      this.close();
    });
  }

  private dispatchWaiters() {
    try {
      while (this.waiters.length > 0) {
        const parsed = parseSmtpResponseFromBuffer(this.buffer);
        if (!parsed) break;
        this.buffer = parsed.remaining;
        const waiter = this.waiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(parsed.response);
      }
    } catch (err) {
      this.failWaiters(err instanceof Error ? err : new Error(String(err)));
      this.close();
    }
  }

  private failWaiters(err: Error) {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  async connect(port: number, mode: 'implicit' | 'starttls'): Promise<void> {
    if (mode === 'implicit') {
      await new Promise<void>((resolve, reject) => {
        let connected = false;
        const timer = setTimeout(() => {
          if (!connected) {
            sock.destroy();
            reject(new Error('SMTP connection timed out'));
          }
        }, 15_000);

        const sock = tls.connect({
          host: this.host,
          port,
          rejectUnauthorized: true,
          ...(this.ca ? { ca: this.ca } : {}),
          ...(this.isIp ? {} : { servername: this.host }),
        });

        sock.once('secureConnect', () => {
          connected = true;
          clearTimeout(timer);
          this.socket = sock;
          this.isTls = true;
          this.attachHandlers(sock);
          resolve();
        });

        sock.once('error', (err) => {
          if (!connected) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        let connected = false;
        const timer = setTimeout(() => {
          if (!connected) {
            sock.destroy();
            reject(new Error('SMTP connection timed out'));
          }
        }, 15_000);

        const sock = net.connect({
          host: this.host,
          port,
        });

        sock.once('connect', () => {
          connected = true;
          clearTimeout(timer);
          this.socket = sock;
          this.isTls = false;
          this.attachHandlers(sock);
          resolve();
        });

        sock.once('error', (err) => {
          if (!connected) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    }
  }

  async upgradeStarttls(): Promise<void> {
    if (!this.socket || this.isTls || this.closed) {
      throw new Error('Socket cannot be upgraded to STARTTLS');
    }
    const plainSocket = this.socket;
    plainSocket.removeAllListeners('data');
    plainSocket.removeAllListeners('error');
    plainSocket.removeAllListeners('close');
    plainSocket.removeAllListeners('end');
    this.buffer = '';

    await new Promise<void>((resolve, reject) => {
      let upgraded = false;
      const timer = setTimeout(() => {
        if (!upgraded) {
          tlsSocket.destroy();
          reject(new Error('STARTTLS handshake timed out'));
        }
      }, 15_000);

      const tlsSocket = tls.connect({
        socket: plainSocket,
        host: this.host,
        rejectUnauthorized: true,
        ...(this.ca ? { ca: this.ca } : {}),
        ...(this.isIp ? {} : { servername: this.host }),
      });

      tlsSocket.once('secureConnect', () => {
        upgraded = true;
        clearTimeout(timer);
        this.socket = tlsSocket;
        this.isTls = true;
        this.attachHandlers(tlsSocket);
        resolve();
      });

      tlsSocket.once('error', (err) => {
        if (!upgraded) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  readResponse(timeoutMs = 30_000): Promise<SmtpResponse> {
    const parsed = parseSmtpResponseFromBuffer(this.buffer);
    if (parsed) {
      this.buffer = parsed.remaining;
      return Promise.resolve(parsed.response);
    }
    if (this.closed) {
      return Promise.reject(new Error('Socket closed unexpectedly before SMTP response'));
    }

    return new Promise<SmtpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error('SMTP command timed out'));
      }, timeoutMs);

      this.waiters.push({ resolve, reject, timer });
    });
  }

  async sendCommand(cmd: string, timeoutMs = 30_000): Promise<SmtpResponse> {
    if (!this.socket || this.closed) throw new Error('Socket is not connected');
    const line = cmd.endsWith('\r\n') ? cmd : `${cmd}\r\n`;
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(line, 'utf-8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return this.readResponse(timeoutMs);
  }

  async writeRaw(data: string | Buffer): Promise<void> {
    if (!this.socket || this.closed) throw new Error('Socket is not connected');
    return new Promise<void>((resolve, reject) => {
      this.socket!.write(data, typeof data === 'string' ? 'utf-8' : undefined, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close() {
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      // Best-effort destroy
    }
    this.socket = null;
  }
}

function validateRecipients(to: string, cc?: string): { toAddresses: string[]; ccAddresses: string[] } {
  if (to.includes('\r') || to.includes('\n')) {
    throw new Error('Invalid email recipient header: newline detected');
  }
  const toParts = to.split(',').map((s) => s.trim()).filter(Boolean);
  if (!toParts.length) throw new Error('Recipient address is required');
  const toAddresses: string[] = [];
  for (const part of toParts) {
    const addr = senderAddress(part);
    if (!addr) throw new Error(`Invalid recipient address: ${part}`);
    toAddresses.push(addr);
  }

  const ccAddresses: string[] = [];
  if (cc !== undefined && cc !== null && cc !== '') {
    if (cc.includes('\r') || cc.includes('\n')) {
      throw new Error('Invalid email recipient header: newline detected');
    }
    const ccParts = cc.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of ccParts) {
      const addr = senderAddress(part);
      if (!addr) throw new Error(`Invalid CC recipient address: ${part}`);
      ccAddresses.push(addr);
    }
  }

  return { toAddresses, ccAddresses };
}

function buildSmtpMime(input: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${input.body}`;
}

function dotStuffMime(mime: string): string {
  const normalized = mime.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const stuffedLines = lines.map((line) => (line.startsWith('.') ? '.' + line : line));
  return stuffedLines.join('\r\n');
}

async function findFolderByRole(client: ImapFlow, role: 'sent' | 'drafts'): Promise<string> {
  const folders = await client.list();
  const targetSpecial = role === 'sent' ? '\\sent' : '\\drafts';
  const bySpecial = folders.find((f) => f.specialUse && f.specialUse.toLowerCase() === targetSpecial);
  if (bySpecial) return bySpecial.path;

  const names =
    role === 'sent'
      ? ['sent', 'sent messages', 'sent items']
      : ['drafts', 'draft'];
  const byName = folders.find((f) => {
    const lower = f.path.toLowerCase();
    const lastPart = lower.split(/[./\\]/).pop() ?? '';
    return names.includes(lower) || names.includes(lastPart);
  });
  if (byName) return byName.path;

  throw new Error(`Target mailbox folder for ${role} not found`);
}

function normalizeMessageId(id?: string | null): string {
  if (!id) return '';
  const trimmed = id.trim();
  const bracketMatch = trimmed.match(/<([^<>]+)>/);
  if (bracketMatch) return bracketMatch[1].trim().toLowerCase();
  return trimmed.replace(/^<|>$/g, '').trim().toLowerCase();
}

export async function sendSelfHostedSmtpMessage(input: SendSelfHostedSmtpInput): Promise<SendSelfHostedSmtpResult> {
  const env = input.env ?? process.env;
  const isPilot = (env.PILOT_MODE ?? process.env.PILOT_MODE) !== 'false';

  // 1. Pilot / User-initiation guard
  if (input.automated === true || !input.userInitiated) {
    if (isPilot) {
      throw new Error('Automatic sending and forwarding are disabled in pilot mode');
    }
    throw new Error('Explicit user initiation is required for outbound SMTP');
  }

  // 2. Strict CRLF injection checks
  if (input.subject.includes('\r') || input.subject.includes('\n')) {
    throw new Error('Subject cannot contain newlines');
  }
  if (input.from && (input.from.includes('\r') || input.from.includes('\n'))) {
    throw new Error('From header cannot contain newlines');
  }
  if (input.inReplyTo && (input.inReplyTo.includes('\r') || input.inReplyTo.includes('\n'))) {
    throw new Error('In-Reply-To header cannot contain newlines');
  }
  if (input.references && (input.references.includes('\r') || input.references.includes('\n'))) {
    throw new Error('References header cannot contain newlines');
  }
  if (input.rfc822MessageId && (input.rfc822MessageId.includes('\r') || input.rfc822MessageId.includes('\n'))) {
    throw new Error('Message-ID cannot contain newlines');
  }
  if (input.draftId && (input.draftId.includes('\r') || input.draftId.includes('\n'))) {
    throw new Error('Draft ID cannot contain newlines');
  }
  if (input.threadId && (input.threadId.includes('\r') || input.threadId.includes('\n'))) {
    throw new Error('Thread ID cannot contain newlines');
  }

  const { toAddresses, ccAddresses } = validateRecipients(input.to, input.cc);

  // 3. Ownership & sender alignment
  const account = await input.prisma.emailAccount.findFirst({
    where: {
      id: input.emailAccountId,
      userId: input.sessionUserId,
      provider: 'selfhosted',
    },
    select: {
      id: true,
      userId: true,
      email: true,
    },
  });
  if (!account) {
    throw new Error('Mailbox unavailable');
  }

  if (input.from) {
    const extractedFrom = senderAddress(input.from);
    if (!extractedFrom || extractedFrom.toLowerCase() !== account.email.toLowerCase()) {
      throw new Error('Sender alignment mismatch');
    }
  }

  // 4. Server config & verified TLS
  const host = configuredSmtpHostname(env);
  const { port, mode } = configuredSmtpPortAndMode(env);
  const ca = await loadCa(env.SELF_HOSTED_TLS_CA_FILE);
  const isIp = isIpv4(host);

  // 5. Message IDs, hashing, duplicate prevention
  const domain = account.email.split('@')[1] || 'localhost';
  const rfc822MessageId = input.rfc822MessageId
    ? input.rfc822MessageId.startsWith('<')
      ? input.rfc822MessageId
      : `<${input.rfc822MessageId}>`
    : `<${randomUUID()}@${domain}>`;

  const bodyHash = createHash('sha256')
    .update(
      JSON.stringify({
        to: input.to,
        cc: input.cc ?? '',
        subject: input.subject,
        body: input.body,
        inReplyTo: input.inReplyTo ?? '',
        draftId: input.draftId ?? '',
      })
    )
    .digest('hex');

  const existingDelivery = await input.prisma.outboundMessageDelivery.findFirst({
    where: {
      emailAccountId: account.id,
      OR: [
        { rfc822MessageId },
        {
          bodyHash,
          status: { in: ['CLAIMED', 'UNCERTAIN', 'COMPLETED'] },
          ...(input.draftId ? { draftId: input.draftId } : {}),
        },
      ],
    },
  });
  if (existingDelivery) {
    throw new Error('Duplicate outbound delivery detected');
  }

  const effectiveThreadId =
    input.threadId ??
    (await resolveSelfHostedThreadId({
      prisma: input.prisma,
      userId: account.userId,
      accountId: account.id,
      inReplyTo: input.inReplyTo,
      references: input.references,
    }));

  const delivery = await input.prisma.outboundMessageDelivery.create({
    data: {
      emailAccountId: account.id,
      userId: account.userId,
      threadId: effectiveThreadId,
      draftId: input.draftId ?? null,
      rfc822MessageId,
      toEmail: input.to,
      ccEmail: input.cc ?? null,
      subject: input.subject,
      bodyHash,
      status: 'CLAIMED',
    },
  });

  const mime = buildSmtpMime({
    from: account.email,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    messageId: rfc822MessageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });
  const dotStuffedMime = dotStuffMime(mime);

  let phase: 'PRE_DATA' | 'IN_DATA' = 'PRE_DATA';
  let session: SmtpSocketSession | null = null;

  try {
    session = new SmtpSocketSession({ host, isIp, ca });
    await session.connect(port, mode);

    const greeting = await session.readResponse(15_000);
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting rejected: code ${greeting.code} ${greeting.lines[0] || ''}`.trim());
    }

    const ehloDomain = domain;
    const ehloRes = await session.sendCommand(`EHLO ${ehloDomain}`);
    if (ehloRes.code !== 250) {
      throw new Error(`EHLO rejected: code ${ehloRes.code} ${ehloRes.lines[0] || ''}`.trim());
    }

    if (mode === 'starttls') {
      const hasStarttls = ehloRes.lines.some((line) => /\bSTARTTLS\b/i.test(line));
      if (!hasStarttls) {
        throw new Error('SMTP server does not support STARTTLS');
      }
      const starttlsRes = await session.sendCommand('STARTTLS');
      if (starttlsRes.code !== 220) {
        throw new Error(`STARTTLS declined: code ${starttlsRes.code} ${starttlsRes.lines[0] || ''}`.trim());
      }
      await session.upgradeStarttls();

      const ehlo2Res = await session.sendCommand(`EHLO ${ehloDomain}`);
      if (ehlo2Res.code !== 250) {
        throw new Error(`Post-STARTTLS EHLO rejected: code ${ehlo2Res.code} ${ehlo2Res.lines[0] || ''}`.trim());
      }
    }

    const credential = await getSelfHostedCredential({
      prisma: input.prisma,
      userId: account.userId,
      accountId: account.id,
    });
    const authPayload = Buffer.from(`\0${credential.username}\0${credential.password}`, 'utf-8').toString('base64');
    const authRes = await session.sendCommand(`AUTH PLAIN ${authPayload}`);
    if (authRes.code !== 235) {
      throw new Error(`SMTP authentication failed: code ${authRes.code}`);
    }

    const mailRes = await session.sendCommand(`MAIL FROM:<${account.email}>`);
    if (mailRes.code !== 250) {
      throw new Error(`SMTP MAIL FROM rejected: code ${mailRes.code} ${mailRes.lines[0] || ''}`.trim());
    }

    const allRecipients = [...toAddresses, ...ccAddresses];
    for (const addr of allRecipients) {
      const rcptRes = await session.sendCommand(`RCPT TO:<${addr}>`);
      if (rcptRes.code !== 250 && rcptRes.code !== 251) {
        throw new Error(`SMTP RCPT TO rejected: code ${rcptRes.code} ${rcptRes.lines[0] || ''}`.trim());
      }
    }

    const dataRes = await session.sendCommand('DATA');
    if (dataRes.code !== 354) {
      throw new Error(`SMTP DATA rejected: code ${dataRes.code} ${dataRes.lines[0] || ''}`.trim());
    }

    phase = 'IN_DATA';
    await session.writeRaw(`${dotStuffedMime}\r\n.\r\n`);
    const finalRes = await session.readResponse(30_000);

    if (finalRes.code === 250) {
      await session.sendCommand('QUIT').catch(() => {});
      session.close();

      await input.prisma.outboundMessageDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'COMPLETED',
          smtpResponse: finalRes.fullText,
          completedAt: new Date(),
        },
      });

      // Post-send best-effort IMAP sync
      if (input.appendToSent !== false && (env.SELF_HOSTED_IMAP_HOST || input.createImapClient)) {
        try {
          const postSendImapEnv = input.createImapClient
            ? { SELF_HOSTED_IMAP_HOST: '127.0.0.1', ...input.env }
            : input.env;

          await withSelfHostedImapClient(
            {
              prisma: input.prisma,
              userId: account.userId,
              accountId: account.id,
              env: postSendImapEnv,
              createClient: input.createImapClient,
            },
            async (client) => {
              const sentFolder = await findFolderByRole(client, 'sent');
              const lock = await client.getMailboxLock(sentFolder);
              let appendInfo: { uid: bigint; uidValidity: bigint; destFolder: string } | null = null;
              try {
                if (!client.mailbox || client.mailbox.uidValidity === undefined || client.mailbox.uidValidity === null) {
                  throw new Error('Mailbox location changed');
                }
                const uidValidity = BigInt(client.mailbox.uidValidity);
                const search = await client.search({ header: { 'message-id': rfc822MessageId } }, { uid: true });
                const existingUids = Array.isArray(search) ? search : [];
                if (existingUids.length === 0) {
                  const rawMimeBuffer = Buffer.from(mime, 'utf-8');
                  const appendResult = await client.append(sentFolder, rawMimeBuffer, ['\\Seen']);
                  if (appendResult && appendResult.uid) {
                    appendInfo = {
                      uid: BigInt(appendResult.uid),
                      uidValidity: appendResult.uidValidity ? BigInt(appendResult.uidValidity) : uidValidity,
                      destFolder: sentFolder,
                    };
                  }
                }
              } finally {
                lock.release();
              }

              if (input.draftId) {
                try {
                  const draft = await input.prisma.emailMessage.findFirst({
                    where: {
                      emailAccountId: account.id,
                      messageId: input.draftId,
                    },
                  });
                  if (draft?.imapFolder && draft.imapUid !== null && draft.imapUidValidity !== null) {
                    const draftLock = await client.getMailboxLock(draft.imapFolder);
                    try {
                      if (client.mailbox && BigInt(client.mailbox.uidValidity) === BigInt(draft.imapUidValidity)) {
                        await client.messageDelete(Number(draft.imapUid), { uid: true });
                      }
                    } finally {
                      draftLock.release();
                    }
                  }
                  if (draft) {
                    await input.prisma.emailMessage.delete({ where: { id: draft.id } }).catch(() => {});
                  }
                } catch {
                  // Best-effort draft cleanup
                }
              }

              const existingEmailMsg = await input.prisma.emailMessage.findFirst({
                where: {
                  emailAccountId: account.id,
                  headerMessageId: rfc822MessageId,
                },
              });
              if (!existingEmailMsg) {
                await input.prisma.emailMessage.create({
                  data: {
                    emailAccountId: account.id,
                    threadId: effectiveThreadId,
                    messageId: randomUUID(),
                    fromEmail: account.email,
                    toEmail: input.to,
                    ccEmail: input.cc ?? null,
                    subject: input.subject,
                    snippet: input.body.slice(0, 240),
                    textBody: input.body,
                    headerMessageId: rfc822MessageId,
                    inReplyTo: input.inReplyTo ?? null,
                    references: input.references ?? null,
                    internalDate: new Date(),
                    labels: ['SENT'],
                    unread: false,
                    archived: false,
                    ...(appendInfo
                      ? {
                          imapFolder: appendInfo.destFolder,
                          imapUid: appendInfo.uid,
                          imapUidValidity: appendInfo.uidValidity,
                        }
                      : {}),
                  },
                });
              }
            }
          );
        } catch {
          // Delivery is committed; transient IMAP failure does not revert COMPLETED
        }
      }

      // Ensure cached EmailMessage exists even if IMAP is not configured
      const existingEmailMsg = await input.prisma.emailMessage.findFirst({
        where: {
          emailAccountId: account.id,
          headerMessageId: rfc822MessageId,
        },
      });
      if (!existingEmailMsg) {
        await input.prisma.emailMessage
          .create({
            data: {
              emailAccountId: account.id,
              threadId: effectiveThreadId,
              messageId: randomUUID(),
              fromEmail: account.email,
              toEmail: input.to,
              ccEmail: input.cc ?? null,
              subject: input.subject,
              snippet: input.body.slice(0, 240),
              textBody: input.body,
              headerMessageId: rfc822MessageId,
              inReplyTo: input.inReplyTo ?? null,
              references: input.references ?? null,
              internalDate: new Date(),
              labels: ['SENT'],
              unread: false,
              archived: false,
            },
          })
          .catch(() => {});
      }

      return {
        deliveryId: delivery.id,
        rfc822MessageId,
        smtpResponse: finalRes.fullText,
        threadId: effectiveThreadId,
      };
    } else {
      throw new SmtpRejectionError(
        `SMTP message rejected: code ${finalRes.code} ${finalRes.lines[0] || ''}`.trim(),
        finalRes.code
      );
    }
  } catch (err: unknown) {
    session?.close();
    const errorObj = err instanceof Error ? err : new Error(String(err));
    const sanitized = sanitizeError(errorObj.message);

    if (err instanceof SmtpRejectionError || phase === 'PRE_DATA') {
      await input.prisma.outboundMessageDelivery
        .update({
          where: { id: delivery.id },
          data: {
            status: 'FAILED',
            error: sanitized,
          },
        })
        .catch(() => {});
      throw errorObj;
    } else {
      await input.prisma.outboundMessageDelivery
        .update({
          where: { id: delivery.id },
          data: {
            status: 'UNCERTAIN',
            error: sanitized,
          },
        })
        .catch(() => {});
      throw new Error('Outbound delivery outcome is uncertain; reconcile Sent folder before retrying');
    }
  }
}

export async function reconcileUncertainOutboundDelivery(
  input: ReconcileUncertainDeliveryInput
): Promise<ReconcileUncertainDeliveryResult> {
  const delivery = await input.prisma.outboundMessageDelivery.findFirst({
    where: {
      id: input.deliveryId,
      userId: input.sessionUserId,
      emailAccount: {
        userId: input.sessionUserId,
        provider: 'selfhosted',
      },
    },
    include: {
      emailAccount: true,
    },
  });

  if (!delivery || delivery.emailAccount.userId !== input.sessionUserId || delivery.emailAccount.provider !== 'selfhosted') {
    throw new Error('Outbound delivery not found');
  }

  if (delivery.status !== 'UNCERTAIN') {
    throw new Error('Delivery is not in an uncertain status');
  }

  const account = delivery.emailAccount;

  let foundMatch = false;
  let matchedUid: number | null = null;
  let matchedUidValidity: bigint | null = null;
  let matchedSentFolder: string | null = null;
  let parsedMatchedEmail: Awaited<ReturnType<typeof parseRawEmail>> | null = null;

  // IMAP connection will throw if connection/scan fails, leaving UNCERTAIN intact in DB.
  const imapEnv = input.createImapClient
    ? { SELF_HOSTED_IMAP_HOST: '127.0.0.1', ...input.env }
    : input.env;

  await withSelfHostedImapClient(
    {
      prisma: input.prisma,
      userId: account.userId,
      accountId: account.id,
      env: imapEnv,
      createClient: input.createImapClient,
    },
    async (client) => {
      const sentFolder = await findFolderByRole(client, 'sent');
      const lock = await client.getMailboxLock(sentFolder);
      try {
        if (!client.mailbox || client.mailbox.uidValidity === undefined || client.mailbox.uidValidity === null) {
          throw new Error('Mailbox location changed');
        }
        const uidValidity = BigInt(client.mailbox.uidValidity);
        const searchResults = await client.search({ all: true }, { uid: true });
        const uids: number[] = Array.isArray(searchResults)
          ? searchResults.map(Number).sort((a, b) => b - a)
          : [];

        for (const uid of uids) {
          const fetched = await client.fetchOne(
            String(uid),
            { source: true, uid: true, flags: true, internalDate: true },
            { uid: true }
          );
          if (!fetched || typeof fetched !== 'object' || !('source' in fetched) || !fetched.source) continue;

          const parsed = await parseRawEmail(new Uint8Array(fetched.source));
          const normHeader = normalizeMessageId(parsed.messageId);
          const normDelivery = normalizeMessageId(delivery.rfc822MessageId);

          if (!normHeader || !normDelivery || normHeader !== normDelivery) {
            continue;
          }

          const parsedSender = senderAddress(parsed.from);
          if (!parsedSender || parsedSender.toLowerCase() !== account.email.toLowerCase()) {
            continue;
          }

          const expectedRecipients = delivery.toEmail.split(',').map((s) => senderAddress(s)).filter(Boolean);
          const parsedRecipients = parsed.to.split(',').map((s) => senderAddress(s)).filter(Boolean);
          const hasRecipientMatch =
            expectedRecipients.length > 0 &&
            expectedRecipients.every((expected) =>
              parsedRecipients.some((r) => r && r.toLowerCase() === expected!.toLowerCase())
            );

          if (!hasRecipientMatch) {
            continue;
          }

          foundMatch = true;
          matchedUid = uid;
          matchedUidValidity = uidValidity;
          matchedSentFolder = sentFolder;
          parsedMatchedEmail = parsed;
          break;
        }
      } finally {
        lock.release();
      }
    }
  );

  if (foundMatch && parsedMatchedEmail && matchedSentFolder && matchedUid && matchedUidValidity) {
    const matchedEmail = parsedMatchedEmail as RawEmail;
    const existingMsg = await input.prisma.emailMessage.findFirst({
      where: {
        emailAccountId: account.id,
        headerMessageId: delivery.rfc822MessageId,
      },
    });
    if (!existingMsg) {
      await input.prisma.emailMessage.create({
        data: {
          emailAccountId: account.id,
          threadId: delivery.threadId ?? `imap-thread-${randomUUID()}`,
          messageId: randomUUID(),
          fromEmail: account.email,
          toEmail: delivery.toEmail,
          ccEmail: delivery.ccEmail,
          subject: delivery.subject,
          snippet: matchedEmail.text.slice(0, 240),
          textBody: matchedEmail.text,
          htmlBody: matchedEmail.html ?? null,
          headerMessageId: delivery.rfc822MessageId,
          internalDate: matchedEmail.date ?? new Date(),
          labels: ['SENT'],
          unread: false,
          archived: false,
          imapFolder: matchedSentFolder,
          imapUid: BigInt(matchedUid),
          imapUidValidity: matchedUidValidity,
        },
      });
    }

    await input.prisma.outboundMessageDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        smtpResponse: 'Reconciled in Sent folder',
      },
    });

    return { status: 'COMPLETED' as const, deliveryId: delivery.id };
  } else {
    await input.prisma.outboundMessageDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        error: 'Confirmed absent in Sent folder after scan',
      },
    });

    return { status: 'FAILED' as const, deliveryId: delivery.id };
  }
}
