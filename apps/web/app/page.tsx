import { headers } from 'next/headers';
import { Workspace } from './components/workspace';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const host = (await headers()).get('host') ?? '';
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const token = local && process.env.LOCAL_EMULATOR_MODE === '1' ? process.env.LOCAL_EMULATOR_TOKEN ?? '' : '';
  return <Workspace token={token} initialView="important"/>;
}
