import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { authenticateUserApiKey, createUserApiKey, revokeUserApiKey } from '../utils/server/api-keys';

describe('user API keys', () => {
  it('stores a hash, authenticates only active keys, and scopes revocation to the owner', async () => {
    const create = vi.fn(async ({ data }: { data: { keyHash: string; name: string } }) => ({ id: 'key', name: data.name, createdAt: new Date(), expiresAt: null }));
    const findUnique = vi.fn(async (args: unknown) => { void args; return { id: 'key', userId: 'owner', revokedAt: null as Date | null, expiresAt: null as Date | null }; });
    const updateMany = vi.fn(async (args: unknown) => { void args; return { count: 1 }; });
    const db = { userApiKey: { create, findUnique, updateMany } } as unknown as Pick<PrismaClient, 'userApiKey'>;
    const { key, token } = await createUserApiKey(db, { userId: 'owner', name: ' Work ' });
    expect(token).toMatch(/^oiz_[0-9a-f]{64}$/);
    expect(key.name).toBe('Work');
    expect(create.mock.calls[0][0].data.keyHash).not.toContain(token);
    expect(await authenticateUserApiKey(db, token)).toEqual({ userId: 'owner', keyId: 'key' });
    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { keyHash: createHash('sha256').update(token).digest('hex') } });
    findUnique.mockResolvedValueOnce({ id: 'key', userId: 'owner', revokedAt: new Date(), expiresAt: null });
    expect(await authenticateUserApiKey(db, token)).toBeNull();
    findUnique.mockResolvedValueOnce({ id: 'key', userId: 'owner', revokedAt: null, expiresAt: new Date('2020-01-01') });
    expect(await authenticateUserApiKey(db, token)).toBeNull();
    expect(await revokeUserApiKey(db, { userId: 'owner', keyId: 'key' })).toBe(true);
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'key', userId: 'owner', revokedAt: null } });
    expect(await authenticateUserApiKey(db, 'bad')).toBeNull();
  });
});
