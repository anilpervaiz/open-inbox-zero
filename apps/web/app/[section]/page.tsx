import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Workspace } from '../components/workspace';
export const dynamic = 'force-dynamic';
const sections = ['rules', 'unsubscribe', 'cold-email', 'analytics'] as const;
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section as typeof sections[number])) notFound();
  const host = (await headers()).get('host') ?? '';
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const token = local && process.env.LOCAL_EMULATOR_MODE === '1' ? process.env.LOCAL_EMULATOR_TOKEN ?? '' : '';
  return <Workspace token={token} initialView={section as typeof sections[number]}/>;
}
