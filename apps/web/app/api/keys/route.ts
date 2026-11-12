import { z } from 'zod';
import { prisma } from '../../../utils/server/prisma';
import { createUserApiKey, revokeUserApiKey } from '../../../utils/server/api-keys';
import { workspacePrincipal, workspaceRateLimit } from '../../../utils/server/workspace-auth';

const headers = { 'Cache-Control': 'no-store' };
const create = z.object({ name: z.string().trim().min(1).max(120), expiresAt: z.iso.datetime().optional() }).strict();
const revoke = z.object({ keyId: z.string().trim().min(1).max(256) }).strict();
async function authorize(request: Request): Promise<{ error: Response } | { userId: string }> {
  const principal = await workspacePrincipal(request);
  if (!principal || principal.kind !== 'session') return { error: Response.json({ error: 'Unauthorized' }, { status: 401, headers }) } as const;
  const limited = await workspaceRateLimit(principal, principal.userId);
  return limited ? { error: limited } as const : { userId: principal.userId } as const;
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Invalid content type');
  const value = await request.text();
  if (Buffer.byteLength(value) > 4096) throw new Error('Request too large');
  return JSON.parse(value) as unknown;
}
export async function GET(request: Request) {
  try {
    const auth = await authorize(request); if ('error' in auth) return auth.error;
    const keys = await prisma.userApiKey.findMany({ where: { userId: auth.userId }, select: { id: true, name: true, createdAt: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Response.json({ keys }, { headers });
  } catch { return Response.json({ error: 'Keys could not be loaded' }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  try {
    const auth = await authorize(request); if ('error' in auth) return auth.error;
    const parsed = create.safeParse(await body(request)); if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers });
    const created = await createUserApiKey(prisma, { userId: auth.userId, name: parsed.data.name, ...(parsed.data.expiresAt ? { expiresAt: new Date(parsed.data.expiresAt) } : {}) });
    return Response.json(created, { status: 201, headers });
  } catch { return Response.json({ error: 'Key could not be created' }, { status: 400, headers }); }
}
export async function DELETE(request: Request) {
  try {
    const auth = await authorize(request); if ('error' in auth) return auth.error;
    const parsed = revoke.safeParse(await body(request)); if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers });
    if (!await revokeUserApiKey(prisma, { userId: auth.userId, keyId: parsed.data.keyId })) return Response.json({ error: 'Key not found' }, { status: 404, headers });
    return Response.json({ ok: true }, { headers });
  } catch { return Response.json({ error: 'Key could not be revoked' }, { status: 400, headers }); }
}
