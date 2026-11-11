import { z } from 'zod';
import { generateDigest } from '../../../utils/ai/digest/digest';
import { authorizeLocalApi } from '../../../utils/server/local-api-auth';
import { prisma } from '../../../utils/server/prisma';

const params = z.object({ accountId: z.string().trim().min(1).max(256), start: z.iso.datetime().optional(), end: z.iso.datetime().optional() }).strict();

/** The local launcher issues the secret; real account sessions are added separately. */
export async function GET(request: Request): Promise<Response> {
  if (!authorizeLocalApi(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const parsed = params.safeParse({ accountId: query.get('accountId'), ...(query.has('start') ? { start: query.get('start') } : {}), ...(query.has('end') ? { end: query.get('end') } : {}) });
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  try {
    const account = await prisma.emailAccount.findUnique({ where: { id: parsed.data.accountId } });
    if (!account || account.provider !== 'emulator') return Response.json({ error: 'Account not found' }, { status: 404 });
    return Response.json(await generateDigest({ prisma, emailAccountId: account.id, ...(parsed.data.start ? { windowStart: new Date(parsed.data.start) } : {}), ...(parsed.data.end ? { windowEnd: new Date(parsed.data.end) } : {}) }));
  } catch {
    return Response.json({ error: 'Digest could not be generated' }, { status: 400 });
  }
}
