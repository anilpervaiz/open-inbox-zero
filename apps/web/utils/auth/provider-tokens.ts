import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { decryptToken, encryptToken } from '../encryption';

const tokenResponse = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384).optional(),
  expires_in: z.number().int().min(1).max(31_536_000),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
});

/** Obtain a usable provider token, serializing refreshes in PostgreSQL across workers. */
export async function getProviderAccessToken(input: { prisma: PrismaClient; emailAccountId: string; requestFetch?: typeof fetch; env?: Record<string, string | undefined>; now?: () => number }): Promise<string> {
  const { prisma, emailAccountId, requestFetch = fetch, env = process.env, now = Date.now } = input;
  if (!emailAccountId) throw new Error('Account required');
  return prisma.$transaction(async tx => {
    // Transaction-scoped locks are released automatically on disconnect or rollback.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-token:${emailAccountId}`}))::text`;
    const account = await tx.emailAccount.findUnique({ where: { id: emailAccountId } });
    if (!account || !['google', 'microsoft'].includes(account.provider)) throw new Error('Provider account unavailable');
    if (account.encryptedAccessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() > now() + 60_000) return decryptToken(account.encryptedAccessToken);
    if (!account.encryptedRefreshToken) throw new Error('Provider authorization must be renewed');
    const isGoogle = account.provider === 'google';
    const clientId = isGoogle ? env.GOOGLE_CLIENT_ID : env.MICROSOFT_CLIENT_ID;
    const clientSecret = isGoogle ? env.GOOGLE_CLIENT_SECRET : env.MICROSOFT_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Provider authorization is not configured');
    const endpoint = isGoogle ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: decryptToken(account.encryptedRefreshToken) });
    let response: Response;
    try { response = await requestFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
    catch { throw new Error('Provider token refresh failed'); }
    if (!response.ok) throw new Error('Provider token refresh failed');
    let json: unknown;
    try { json = await response.json(); } catch { throw new Error('Provider token refresh failed'); }
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success) throw new Error('Provider token refresh failed');
    const tokens = parsed.data;
    await tx.emailAccount.update({ where: { id: account.id }, data: {
      encryptedAccessToken: encryptToken(tokens.access_token),
      ...(tokens.refresh_token ? { encryptedRefreshToken: encryptToken(tokens.refresh_token) } : {}),
      accessTokenExpiresAt: new Date(now() + tokens.expires_in * 1000),
    } });
    return tokens.access_token;
  }, { timeout: 20_000, maxWait: 5000 });
}
