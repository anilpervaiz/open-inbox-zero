import { gmail } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import type { PrismaClient } from '@prisma/client';
import { getProviderAccessToken } from '../auth/provider-tokens';
import { EmulatedMailProvider } from './emulated-provider';
import { GmailProvider } from './gmail-provider';
import { OutlookProvider } from './outlook-provider';
import { SelfHostedMailProvider } from './self-hosted-provider';
import type { EmailProvider } from './types';

/** Build a provider only from credentials persisted for its mailbox. */
export async function resolveMailProvider(prisma: PrismaClient, emailAccountId: string): Promise<EmailProvider> {
  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId }, select: { provider: true } });
  if (!account) throw new Error('Account not found');
  if (account.provider === 'emulator') return new EmulatedMailProvider(prisma, emailAccountId);
  if (account.provider === 'selfhosted') return new SelfHostedMailProvider(prisma, emailAccountId);
  if (account.provider === 'microsoft') return new OutlookProvider(() => getProviderAccessToken({ prisma, emailAccountId }), emailAccountId);
  if (account.provider === 'google') {
    const accessToken = await getProviderAccessToken({ prisma, emailAccountId });
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    return new GmailProvider(gmail({ version: 'v1', auth }), emailAccountId);
  }
  throw new Error('Unsupported mail provider');
}
