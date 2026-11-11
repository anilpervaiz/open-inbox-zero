import { describe, expect, it } from 'vitest';
import { authConfiguration } from '../utils/auth/session-auth';

describe('session authentication configuration', () => {
  const valid = { BETTER_AUTH_SECRET: 'a'.repeat(40), BETTER_AUTH_URL: 'https://inbox.example', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' };
  it('fails closed when secrets or provider credentials are missing', () => {
    expect(authConfiguration({})).toBeNull();
    expect(authConfiguration({ ...valid, BETTER_AUTH_SECRET: 'short' })).toBeNull();
    expect(authConfiguration({ ...valid, GOOGLE_CLIENT_SECRET: '' })).toBeNull();
  });
  it('requires HTTPS outside loopback and rejects ambiguous base URLs', () => {
    expect(authConfiguration({ ...valid, BETTER_AUTH_URL: 'http://example.com' })).toBeNull();
    expect(authConfiguration({ ...valid, BETTER_AUTH_URL: 'https://example.com/path' })).toBeNull();
    expect(authConfiguration({ ...valid, BETTER_AUTH_URL: 'http://localhost:3000' })?.baseUrl).toBe('http://localhost:3000');
    expect(authConfiguration(valid)?.google?.accessType).toBe('offline');
  });
});
