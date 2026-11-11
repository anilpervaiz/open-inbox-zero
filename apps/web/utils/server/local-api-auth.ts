import { timingSafeEqual } from 'node:crypto';

/** The local launcher creates this secret for one process lifetime; production fails closed. */
export function authorizeLocalApi(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.LOCAL_EMULATOR_TOKEN;
  if (env.LOCAL_EMULATOR_MODE !== '1' || !expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const candidate = authorization.slice(7);
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  const origin = request.headers.get('origin');
  if (origin) {
    try { if (new URL(origin).origin !== new URL(request.url).origin) return false; }
    catch { return false; }
  }
  return true;
}
