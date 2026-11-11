import { describe, expect, it } from 'vitest';
import { authorizeLocalApi } from '../utils/server/local-api-auth';

const token = 'a'.repeat(64);
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', LOCAL_EMULATOR_MODE: '1', LOCAL_EMULATOR_TOKEN: token };
const request = (bearer: string, origin = 'http://127.0.0.1:3000') => new Request('http://127.0.0.1:3000/api/clean', { method: 'POST', headers: { authorization: bearer, origin } });

describe('local API access', () => {
  it('requires the process secret and rejects cross-origin browser requests', () => {
    expect(authorizeLocalApi(request(`Bearer ${token}`), env)).toBe(true);
    const normalized = new Request('http://localhost:3000/api/clean', { headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', authorization: `Bearer ${token}` } });
    expect(authorizeLocalApi(normalized, env)).toBe(true);
    expect(authorizeLocalApi(request(`Bearer ${'b'.repeat(64)}`), env)).toBe(false);
    expect(authorizeLocalApi(request(`Bearer ${token}`, 'https://attacker.example'), env)).toBe(false);
    expect(authorizeLocalApi(request(`Bearer ${token}`), { NODE_ENV: 'test' })).toBe(false);
    expect(authorizeLocalApi(request(`Bearer ${token}`), { ...env, LOCAL_EMULATOR_MODE: '0' })).toBe(false);
  });
});
