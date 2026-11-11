import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const email = z.string().email().max(320).transform(value => value.toLowerCase());
const googleProfile = z.object({ emailAddress: email });
const microsoftProfile = z.object({ mail: email });

/** Bind only a provider identity owned by this user, after looking up its actual mailbox. */
export async function connectOAuthMailbox(input: { prisma: PrismaClient; userId: string; authAccountId: string; getAccessToken: (accountId: string, userId: string) => Promise<string>; requestFetch?: typeof fetch }) {
  const { prisma, userId, authAccountId } = input;
  const identity = await prisma.authAccount.findFirst({ where: { id: authAccountId, userId, providerId: { in: ['google', 'microsoft'] } } });
  if (!identity || !identity.refreshToken) throw new Error('Mailbox authorization is incomplete');
  const scopes = new Set((identity.scope ?? '').split(/[\s,]+/).filter(Boolean).map(item => item.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')));
  const required = identity.providerId === 'google'
    ? ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send']
    : ['mail.readwrite', 'mail.send'];
  const fullGoogleAccess = identity.providerId === 'google' && scopes.has('https://mail.google.com/');
  if (!fullGoogleAccess && required.some(scope => !scopes.has(scope))) throw new Error('Mailbox permissions are incomplete');
  const token = await input.getAccessToken(identity.id, userId);
  if (!token || token.length > 16384) throw new Error('Mailbox authorization is incomplete');
  const url = identity.providerId === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://graph.microsoft.com/v1.0/me?$select=mail';
  let response: Response;
  try { response = await (input.requestFetch ?? fetch)(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error('Mailbox profile unavailable'); }
  if (!response.ok) throw new Error('Mailbox profile unavailable');
  const raw: unknown = await response.json().catch(() => null);
  const profile = identity.providerId === 'google' ? googleProfile.safeParse(raw) : microsoftProfile.safeParse(raw);
  if (!profile.success) throw new Error('Mailbox profile unavailable');
  const address = 'emailAddress' in profile.data ? profile.data.emailAddress : profile.data.mail;
  const existing = await prisma.emailAccount.findFirst({ where: { email: { equals: address, mode: 'insensitive' } } });
  if (existing) {
    if (existing.userId !== userId || existing.authAccountId !== identity.id || existing.provider !== identity.providerId) throw new Error('Mailbox is already connected');
    return { id: existing.id, email: existing.email, provider: existing.provider };
  }
  const mailbox = await prisma.emailAccount.create({ data: { userId, email: address, provider: identity.providerId, authAccountId: identity.id }, select: { id: true, email: true, provider: true } });
  return mailbox;
}
