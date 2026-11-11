import { describe, expect, it, vi } from 'vitest';
import { runCli } from './index';

describe('CLI', () => {
  it('dispatches seed and evaluation commands', async () => {
    const run = vi.fn(async () => {});
    const deps = { fetch, run, env: {} };
    await runCli(['seed'], deps);
    await runCli(['eval'], deps);
    expect(run).toHaveBeenNthCalledWith(1, ['--filter', '@open-inbox-zero/web', 'exec', 'tsx', 'scripts/seed-cli.ts']);
    expect(run).toHaveBeenNthCalledWith(2, ['eval']);
  });
  it('runs rules through the authenticated local API and rejects nonlocal hosts', async () => {
    const mockFetch = vi.fn(async (url: URL, init?: RequestInit) => { void url; void init; return Response.json({ ok: true }); });
    const deps = { fetch: mockFetch as unknown as typeof fetch, run: vi.fn(), env: { LOCAL_EMULATOR_TOKEN: 'secret' } };
    expect(await runCli(['run-rules', 'demo'], deps)).toEqual({ ok: true });
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ operation: 'run-all', accountId: 'demo' });
    await expect(runCli(['digest', 'demo'], { ...deps, env: { ...deps.env, OPEN_INBOX_ZERO_URL: 'https://example.com' } })).rejects.toThrow('loopback');
  });
});
