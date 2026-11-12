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

type ApiKey = { id: string; name: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };
export function ApiKeysPanel({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKey[]>([]); const [name, setName] = useState(''); const [secret, setSecret] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/keys', { cache: 'no-store' });
    if (!response.ok) throw new Error('Access keys could not be loaded.');
    setKeys((await response.json()).keys);
  }
  useEffect(() => { void load().catch(() => setError('Access keys could not be loaded.')); }, []);
  async function change(method: 'POST' | 'DELETE', input: object) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/keys', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error('Access key change could not be completed.');
      const result = await response.json();
      if (method === 'POST') { setSecret(result.token); setName(''); }
      try { await load(); } catch { setError('Change completed, but the key list could not be refreshed.'); }
    } catch { setError('Access key change could not be completed.'); }
    finally { setBusy(false); }
  }
  return <main className="setup-message"><h1>Assistant access keys</h1><p>Keys give an assistant access to your connected mailboxes. Save a new key when it appears; it cannot be shown again.</p>
    <label>Key name <input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
    <button className="primary-button" disabled={busy || !name.trim()} onClick={() => void change('POST', { name })}>Create key</button>
    {secret && <p role="status">New key: <code>{secret}</code></p>}
    {keys.map(key => <div key={key.id}><strong>{key.name}</strong> · {key.revokedAt ? 'Revoked' : key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now() ? 'Expired' : 'Active'} {!key.revokedAt && <button className="text-btn" disabled={busy} onClick={() => void change('DELETE', { keyId: key.id })}>Revoke</button>}</div>)}
    {error && <p role="alert">{error}</p>}<button className="secondary-button" onClick={onClose}>Back to inbox</button></main>;
}
