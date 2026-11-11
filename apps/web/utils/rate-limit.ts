import { createHash } from 'node:crypto';

export interface RateLimitStore {
  consume(keys: readonly string[], windowMs: number): Promise<{ counts: number[]; retryAfterMs: number }>;
}

/** Atomic across app instances when backed by the same Redis server. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: { eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown> }) {}
  async consume(keys: readonly string[], windowMs: number) {
    const result = await this.redis.eval(`
      local result = {}
      local ttl = 0
      for i, key in ipairs(KEYS) do
        local count = redis.call('INCR', key)
        if count == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
        local remaining = redis.call('PTTL', key)
        if remaining < 0 then redis.call('PEXPIRE', key, ARGV[1]); remaining = tonumber(ARGV[1]) end
        if remaining > ttl then ttl = remaining end
        result[i] = count
      end
      result[#KEYS + 1] = ttl
      return result`, keys.length, ...keys, windowMs);
    if (!Array.isArray(result) || result.length !== keys.length + 1 || result.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid rate-limit store response');
    return { counts: result.slice(0, -1) as number[], retryAfterMs: result[result.length - 1] as number };
  }
}

/** For single-process local demos only; never use as a distributed limit. */
export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, { count: number; expires: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly capacity = 10_000) {}
  async consume(keys: readonly string[], windowMs: number) {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    const missing = new Set(keys.filter(key => !this.entries.has(key))).size;
    if (this.entries.size + missing > this.capacity) throw new Error('Rate-limit store capacity exceeded');
    const counts: number[] = []; let retryAfterMs = 0;
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { count: 0, expires: now + windowMs };
      entry.count++; this.entries.set(key, entry); counts.push(entry.count);
      retryAfterMs = Math.max(retryAfterMs, entry.expires - now);
    }
    return { counts, retryAfterMs };
  }
}

export async function checkRateLimit(input: { store: RateLimitStore; scope: string; clientIp: string; accountId: string; limit: number; windowMs: number }) {
  if (!input.scope || !input.clientIp || !input.accountId || !Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1) throw new Error('Invalid rate limit');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const keys = [`oiz:rate:{limits}:${hash(`${input.scope}:ip:${input.clientIp}`)}`, `oiz:rate:{limits}:${hash(`${input.scope}:account:${input.accountId}`)}`];
  const result = await input.store.consume(keys, input.windowMs);
  return { allowed: result.counts.every(count => count <= input.limit), retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) };
}

const shared = globalThis as typeof globalThis & { openInboxLocalRateLimit?: MemoryRateLimitStore };
const localStore = shared.openInboxLocalRateLimit ??= new MemoryRateLimitStore();

/** Only used after local-emulator authentication, where the launcher binds to loopback. */
export async function localRateLimit(accountId: string): Promise<Response | null> {
  try {
    const result = await checkRateLimit({ store: localStore, scope: 'local-api', clientIp: 'loopback', accountId, limit: 120, windowMs: 60_000 });
    return result.allowed ? null : Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } });
  } catch { return Response.json({ error: 'Rate limiter unavailable' }, { status: 503 }); }
}
