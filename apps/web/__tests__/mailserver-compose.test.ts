import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;

it.skipIf(!composeAvailable)('keeps the separate mail-server configuration authenticated and persistent', () => {
  const result = spawnSync('docker', ['compose', '-p', 'oiz-mail-config-test', '-f', 'deploy/mailserver/compose.yaml', 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, MAIL_HOSTNAME: 'mail.example.test', MAIL_TLS_DIR: '/tmp' },
  });
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(result.stdout);
  const server = config.services.mailserver;
  expect(server.environment).toMatchObject({ SSL_TYPE: 'manual', PERMIT_DOCKER: 'none', SPOOF_PROTECTION: '1', ENABLE_RSPAMD: '1', ENABLE_FAIL2BAN: '1' });
  expect(server.ports.map((entry: { target: number }) => entry.target).sort((a: number, b: number) => a - b)).toEqual([25, 465, 587, 993]);
  for (const target of ['/var/mail', '/var/mail-state', '/tmp/docker-mailserver']) expect(server.volumes.some((volume: { target: string; type: string }) => volume.target === target && volume.type === 'volume')).toBe(true);
  expect(server.volumes.some((volume: { target: string; read_only?: boolean }) => volume.target === '/etc/mail-certs' && volume.read_only)).toBe(true);
});
