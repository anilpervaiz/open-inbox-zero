import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveMailProvider } from '../utils/mail-provider/provider-resolver';
import { EmulatedMailProvider } from '../utils/mail-provider/emulated-provider';
import { GmailProvider } from '../utils/mail-provider/gmail-provider';
import { OutlookProvider } from '../utils/mail-provider/outlook-provider';
import { SelfHostedMailProvider } from '../utils/mail-provider/self-hosted-provider';

vi.mock('../utils/auth/provider-tokens', () => ({ getProviderAccessToken: vi.fn(async () => 'test-token') }));

describe('provider resolver', () => {
  it('binds supported providers to the requested account and rejects unknown providers', async () => {
    let provider = 'emulator';
    const prisma = { emailAccount: { findUnique: async () => ({ provider }) } } as unknown as PrismaClient;
    expect(await resolveMailProvider(prisma, 'account')).toBeInstanceOf(EmulatedMailProvider);
    provider = 'selfhosted';
    const selfhosted = await resolveMailProvider(prisma, 'account');
    expect(selfhosted).toBeInstanceOf(SelfHostedMailProvider);
    expect(selfhosted.emailAccountId).toBe('account');
    provider = 'google';
    const google = await resolveMailProvider(prisma, 'account');
    expect(google).toBeInstanceOf(GmailProvider);
    expect(google.emailAccountId).toBe('account');
    provider = 'microsoft';
    const outlook = await resolveMailProvider(prisma, 'account');
    expect(outlook).toBeInstanceOf(OutlookProvider);
    expect(outlook.emailAccountId).toBe('account');
    provider = 'unknown';
    await expect(resolveMailProvider(prisma, 'account')).rejects.toThrow('Unsupported');
  });
});
