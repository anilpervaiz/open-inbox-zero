'use client';

import { createAuthClient } from 'better-auth/react';
import { useEffect, useState } from 'react';

const authClient = createAuthClient();
type Provider = 'google' | 'microsoft';
export function SignInPanel({ providers }: { providers: { google: boolean; microsoft: boolean } }) {
  const [error, setError] = useState('');
  async function signIn(provider: Provider) {
    setError('');
    try { const result = await authClient.signIn.social({ provider, callbackURL: '/' }); if (result.error) setError('Sign-in could not be started.'); }
    catch { setError('Sign-in could not be started.'); }
  }
  return <main className="setup-message"><h1>Open Inbox Zero</h1><p>Connect an email account to organize your inbox. You will be asked to allow reading, organizing, drafting, and sending email.</p>
    {providers.google && <button className="primary-button" onClick={() => void signIn('google')}>Continue with Google</button>}
    {providers.microsoft && <button className="secondary-button" onClick={() => void signIn('microsoft')}>Continue with Microsoft</button>}
    {!providers.google && !providers.microsoft && <p>Start the local demo with <code>pnpm local:start</code>.</p>}{error && <p role="alert">{error}</p>}</main>;
}

export function MailboxSetup({ onConnected, onCancel, providers }: { onConnected: (accountId: string) => Promise<void>; onCancel?: () => void; providers: { google: boolean; microsoft: boolean } }) {
  const [accounts, setAccounts] = useState<{ id: string; providerId: string }[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  useEffect(() => { void authClient.listAccounts().then(result => { if (result.error) setError('Could not load your connected identities.'); else setAccounts(result.data ?? []); }).catch(() => setError('Could not load your connected identities.')).finally(() => setLoading(false)); }, []);
  async function connect(authAccountId: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/accounts/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authAccountId }) });
      if (!response.ok) throw new Error('Connection could not be completed. Check the server configuration and try again.');
      const result = await response.json(); await onConnected(result.mailbox.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connection could not be completed.'); }
    finally { setBusy(false); }
  }
  async function link(provider: Provider) {
    setError('');
    try { const result = await authClient.linkSocial({ provider, callbackURL: '/' }); if (result.error) setError('Account authorization could not be started.'); }
    catch { setError('Account authorization could not be started.'); }
  }
  return <main className="setup-message"><h1>Connect your mailbox</h1><p>Select an authorized account. To add another, authorize it first, then select Add mailbox again.</p>
    {accounts.filter(account => ['google', 'microsoft'].includes(account.providerId)).map(account => <button className="primary-button" key={account.id} disabled={busy} onClick={() => void connect(account.id)}>Connect {account.providerId === 'google' ? 'Google' : 'Microsoft'} mailbox</button>)}
    {providers.google && <button className="secondary-button" disabled={busy} onClick={() => void link('google')}>Authorize another Google account</button>}
    {providers.microsoft && <button className="secondary-button" disabled={busy} onClick={() => void link('microsoft')}>Authorize another Microsoft account</button>}
    {onCancel && <button className="text-btn" onClick={onCancel}>Back to inbox</button>}
    {loading && !error && <p>Loading your authorized accounts…</p>}{!loading && !accounts.length && !error && <p>No authorized accounts yet.</p>}{error && <p role="alert">{error}</p>}</main>;
}

export function SignOutButton() {
  return <button className="text-btn" onClick={() => void authClient.signOut().then(() => { window.location.href = '/'; })}>Sign out</button>;
}
