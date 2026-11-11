import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getProviderAccessToken } from '../utils/auth/provider-tokens';
import { decryptToken, encryptToken } from '../utils/encryption';

afterEach(() => vi.unstubAllEnvs());
const key = Buffer.alloc(32, 11).toString('base64');
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' };

describe('provider token refresh', () => {
  it('reuses a valid encrypted token without calling the provider', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', key);
    const findUnique = vi.fn(async () => ({ id: 'a', provider: 'google', encryptedAccessToken: encryptToken('existing'), accessTokenExpiresAt: new Date(Date.now() + 300_000) }));
    const tx = { $queryRaw: vi.fn(), emailAccount: { findUnique } };
    const prisma = { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient;
    const requestFetch = vi.fn();
    expect(await getProviderAccessToken({ prisma, emailAccountId: 'a', requestFetch, env })).toBe('existing');
    expect(requestFetch).not.toHaveBeenCalled();
  });
  it('refreshes over the fixed HTTPS endpoint and stores rotated tokens encrypted', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', key);
    const findUnique = vi.fn(async () => ({ id: 'a', provider: 'google', encryptedRefreshToken: encryptToken('refresh-old'), accessTokenExpiresAt: null }));
    const update = vi.fn(async (args: { data: { encryptedAccessToken: string; encryptedRefreshToken: string } }) => args);
    const tx = { $queryRaw: vi.fn(), emailAccount: { findUnique, update } };
    const prisma = { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient;
    const requestFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('refresh-old');
      return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, token_type: 'Bearer' });
    });
    expect(await getProviderAccessToken({ prisma, emailAccountId: 'a', requestFetch: requestFetch as typeof fetch, env })).toBe('access-new');
    const data = update.mock.calls[0][0].data;
    expect(data.encryptedAccessToken).not.toContain('access-new');
    expect(decryptToken(data.encryptedAccessToken)).toBe('access-new');
    expect(decryptToken(data.encryptedRefreshToken)).toBe('refresh-new');
  });
  it('does not leak provider errors and rejects malformed token responses', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', key);
    const tx = { $queryRaw: vi.fn(), emailAccount: { findUnique: async () => ({ id: 'a', provider: 'google', encryptedRefreshToken: encryptToken('refresh-old'), accessTokenExpiresAt: null }) } };
    const prisma = { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient;
    const requestFetch = vi.fn(async () => { throw new Error('secret'); });
    await expect(getProviderAccessToken({ prisma, emailAccountId: 'a', requestFetch, env })).rejects.toThrow('Provider token refresh failed');
    await expect(getProviderAccessToken({ prisma, emailAccountId: 'a', requestFetch: async () => Response.json({ access_token: 'x' }), env })).rejects.toThrow('Provider token refresh failed');
  });
});
