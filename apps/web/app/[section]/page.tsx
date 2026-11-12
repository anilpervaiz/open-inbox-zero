import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Workspace } from '../components/workspace';
import { authConfiguration, getSessionAuth } from '../../utils/auth/session-auth';
export const dynamic = 'force-dynamic';
const sections = ['rules', 'unsubscribe', 'cold-email', 'analytics'] as const;
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section as typeof sections[number])) notFound();
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? '';
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const token = local && process.env.LOCAL_EMULATOR_MODE === '1' ? process.env.LOCAL_EMULATOR_TOKEN ?? '' : '';
  const config = authConfiguration();
  const auth = getSessionAuth();
  const session = auth ? await auth.api.getSession({ headers: requestHeaders }).catch(() => null) : null;
  return <Workspace token={token} signedIn={Boolean(session)} providers={{ google: Boolean(config?.google), microsoft: Boolean(config?.microsoft) }} initialView={section as typeof sections[number]}/>;
}
