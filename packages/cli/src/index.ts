import { spawn } from 'node:child_process';

export interface CliDependencies {
  fetch: typeof fetch;
  run: (args: string[]) => Promise<void>;
  env: NodeJS.ProcessEnv;
}

const runPnpm = (args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn('pnpm', args, { stdio: 'inherit', env: process.env });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Command exited with ${signal ?? code}`)));
});

/** Execute a command; the local API token is supplied through the environment, never arguments. */
export async function runCli(args: string[], deps: CliDependencies = { fetch, run: runPnpm, env: process.env }): Promise<unknown> {
  const [command, accountId, extra] = args;
  if (command === 'seed' && !accountId) return deps.run(['--filter', '@open-inbox-zero/web', 'exec', 'tsx', 'scripts/seed-cli.ts']);
  if (command === 'eval' && !accountId) return deps.run(['eval']);
  if ((command !== 'run-rules' && command !== 'digest') || !accountId || extra) throw new Error('Usage: seed | eval | run-rules <account-id> | digest <account-id>');
  const token = deps.env.LOCAL_EMULATOR_TOKEN;
  if (!token) throw new Error('LOCAL_EMULATOR_TOKEN is required');
  const base = new URL(deps.env.OPEN_INBOX_ZERO_URL ?? 'http://127.0.0.1:3000');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('Local CLI requires a loopback HTTP server');
  const url = new URL(command === 'digest' ? '/api/digest' : '/api/workspace', base);
  if (command === 'digest') url.searchParams.set('accountId', accountId);
  const response = await deps.fetch(url, {
    method: command === 'digest' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(command === 'run-rules' ? { 'content-type': 'application/json' } : {}) },
    ...(command === 'run-rules' ? { body: JSON.stringify({ operation: 'run-all', accountId }) } : {}),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}
