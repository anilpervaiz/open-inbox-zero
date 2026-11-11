import { describe, expect, it } from 'vitest';
import { checkRateLimit, localRateLimit, MemoryRateLimitStore, RedisRateLimitStore } from '../utils/rate-limit';

describe('rate limits', () => {
  it('limits both clients and accounts, then expires the window', async () => {
    let time = 0;
    const store = new MemoryRateLimitStore(() => time);
    const check = (clientIp: string, accountId: string) => checkRateLimit({ store, scope: 'mcp', clientIp, accountId, limit: 2, windowMs: 1000 });
    expect((await check('a', 'one')).allowed).toBe(true);
    expect((await check('a', 'two')).allowed).toBe(true);
    expect((await check('a', 'three')).allowed).toBe(false);
    expect((await check('b', 'one')).allowed).toBe(true);
    expect((await check('c', 'one')).allowed).toBe(false);
    time = 1000;
    expect((await check('a', 'one')).allowed).toBe(true);
  });
  it('returns HTTP 429 with a retry time after the local burst limit', async () => {
    for (let i = 0; i < 120; i++) expect(await localRateLimit('burst-test')).toBeNull();
    const response = await localRateLimit('burst-test');
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it('fails closed when its memory capacity or Redis response is invalid', async () => {
    const input = { scope: 'mcp', clientIp: 'a', accountId: 'one', limit: 2, windowMs: 1000 };
    await expect(checkRateLimit({ ...input, store: new MemoryRateLimitStore(() => 0, 1) })).rejects.toThrow('capacity');
    await expect(checkRateLimit({ ...input, store: new RedisRateLimitStore({ eval: async () => ['invalid'] }) })).rejects.toThrow('Invalid');
  });
});
