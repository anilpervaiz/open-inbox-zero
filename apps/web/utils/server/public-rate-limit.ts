import Redis from 'ioredis';
import { MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from '../rate-limit';

const shared = globalThis as typeof globalThis & { publicMemoryLimit?: MemoryRateLimitStore; publicRedis?: Redis; publicRedisUrl?: string };
/** Production fails closed without shared storage. Proxy headers are not trusted here. */
export function publicRateLimitStore(): RateLimitStore {
  const url = process.env.REDIS_URL;
  if (url) {
    if (!shared.publicRedis || shared.publicRedisUrl !== url) {
      shared.publicRedis?.disconnect();
      shared.publicRedis = new Redis(url, { connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
      shared.publicRedis.on('error', () => {});
      shared.publicRedisUrl = url;
    }
    return new RedisRateLimitStore(shared.publicRedis);
  }
  if (process.env.LOCAL_EMULATOR_MODE !== '1') throw new Error('Redis is required');
  return shared.publicMemoryLimit ??= new MemoryRateLimitStore();
}
