import { z } from 'zod';
import { generateDigest } from '../../../utils/ai/digest/digest';
import { workspacePrincipal, workspaceRateLimit } from '../../../utils/server/workspace-auth';
import { prisma } from '../../../utils/server/prisma';

const params = z.object({ accountId: z.string().trim().min(1).max(256), start: z.iso.datetime().optional(), end: z.iso.datetime().optional() }).strict();

/** Digest data is scoped to the authenticated mailbox owner. */
export async function GET(request: Request): Promise<Response> {
  let principal;
  try { principal = await workspacePrincipal(request); } catch { return Response.json({ error: 'Service unavailable' }, { status: 503 }); }
  if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const parsed = params.safeParse({ accountId: query.get('accountId'), ...(query.has('start') ? { start: query.get('start') } : {}), ...(query.has('end') ? { end: query.get('end') } : {}) });
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const limit = await workspaceRateLimit(principal, parsed.data.accountId);
  if (limit) return limit;
  try {
    const account = principal.kind === 'local' ? await prisma.emailAccount.findUnique({ where: { id: parsed.data.accountId } }) : await prisma.emailAccount.findFirst({ where: { id: parsed.data.accountId, userId: principal.userId } });
    if (!account || (principal.kind === 'local' && account.provider !== 'emulator')) return Response.json({ error: 'Account not found' }, { status: 404 });
    return Response.json(await generateDigest({ prisma, emailAccountId: account.id, ...(parsed.data.start ? { windowStart: new Date(parsed.data.start) } : {}), ...(parsed.data.end ? { windowEnd: new Date(parsed.data.end) } : {}) }));
  } catch {
    return Response.json({ error: 'Digest could not be generated' }, { status: 400 });
  }
}
