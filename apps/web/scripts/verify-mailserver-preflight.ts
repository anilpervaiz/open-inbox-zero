import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface PreflightCheckResult {
  category: 'syntax' | 'dns' | 'tls' | 'relay';
  name: string;
  passed: boolean;
  details: string;
  error?: string;
}

export interface PreflightReport {
  domain: string;
  mailHost: string;
  passed: boolean;
  checks: PreflightCheckResult[];
}

export interface DnsProbes {
  resolveA?: (hostname: string) => Promise<string[]>;
  resolveAaaa?: (hostname: string) => Promise<string[]>;
  resolveMx?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
  resolvePtr?: (ip: string) => Promise<string[]>;
}

export interface TlsConnectResult {
  authorized: boolean;
  authorizationError?: Error;
  validTo: Date;
  subjectAltNames: string[];
}

export interface SmtpProbeResult {
  rejected: boolean;
  statusCode: number;
  response: string;
}

export interface MailserverPreflightOptions {
  domain: string;
  mailHost: string;
  dkimSelector?: string;
  ports?: {
    smtps?: number; // 465
    submission?: number; // 587
    imaps?: number; // 993
  };
  dnsLookup?: DnsProbes;
  tlsConnect?: (options: {
    host: string;
    port: number;
    servername: string;
    rejectUnauthorized: boolean;
    starttls?: 'smtp';
  }) => Promise<TlsConnectResult>;
  smtpProbe?: (options: {
    host: string;
    port: number;
    mailFrom: string;
    rcptTo: string;
  }) => Promise<SmtpProbeResult>;
}

const FQDN_REGEX = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})+$/;

export function isValidFqdn(domain: string): boolean {
  return FQDN_REGEX.test(domain.trim().replace(/\.$/, ''));
}

function matchesHostname(certHost: string, expectedHost: string): boolean {
  const normCert = certHost.trim().toLowerCase();
  const normExpected = expectedHost.trim().toLowerCase();
  if (normCert === normExpected) return true;
  if (normCert.startsWith('*.')) {
    const certBase = normCert.slice(2);
    const expectedParts = normExpected.split('.');
    if (expectedParts.length > 2) {
      const expectedBase = expectedParts.slice(1).join('.');
      return certBase === expectedBase;
    }
  }
  return false;
}

const defaultDns: Required<DnsProbes> = {
  resolveA: async (hostname: string) => {
    try {
      return await dns.resolve4(hostname);
    } catch {
      return [];
    }
  },
  resolveAaaa: async (hostname: string) => {
    try {
      return await dns.resolve6(hostname);
    } catch {
      return [];
    }
  },
  resolveMx: async (domain: string) => {
    try {
      return await dns.resolveMx(domain);
    } catch {
      return [];
    }
  },
  resolveTxt: async (hostname: string) => {
    try {
      return await dns.resolveTxt(hostname);
    } catch {
      return [];
    }
  },
  resolvePtr: async (ip: string) => {
    try {
      return await dns.reverse(ip);
    } catch {
      return [];
    }
  },
};

const defaultTlsConnect = async (options: {
  host: string;
  port: number;
  servername: string;
  rejectUnauthorized: boolean;
  starttls?: 'smtp';
}): Promise<TlsConnectResult> => {
  if (options.starttls === 'smtp') {
    return new Promise<TlsConnectResult>((done, fail) => {
      const socket = net.connect({ host: options.host, port: options.port }, () => {
        let buffer = '';
        let step = 'banner';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (step === 'banner' && buffer.includes('\r\n')) {
            buffer = '';
            step = 'ehlo';
            socket.write(`EHLO preflight.local\r\n`);
          } else if (step === 'ehlo' && buffer.includes('250 ') && buffer.includes('\r\n')) {
            buffer = '';
            step = 'starttls';
            socket.write('STARTTLS\r\n');
          } else if (step === 'starttls' && buffer.startsWith('220')) {
            socket.removeAllListeners('data');
            const tlsSocket = tls.connect({
              socket,
              servername: options.servername,
              rejectUnauthorized: options.rejectUnauthorized,
            });

            tlsSocket.on('secureConnect', () => {
              const cert = tlsSocket.getPeerCertificate();
              const validTo = new Date(cert.valid_to);
              const altNames = cert.subjectaltname
                ? cert.subjectaltname.split(', ').map((s) => s.replace(/^DNS:/, ''))
                : [cert.subject?.CN].filter(Boolean) as string[];
              tlsSocket.end();
              done({
                authorized: tlsSocket.authorized,
                authorizationError: tlsSocket.authorizationError,
                validTo,
                subjectAltNames: altNames,
              });
            });

            tlsSocket.on('error', (err) => {
              fail(err);
            });
          }
        });
      });

      socket.setTimeout(10_000, () => {
        socket.destroy();
        fail(new Error('Connection timed out during SMTP STARTTLS negotiation'));
      });
      socket.on('error', fail);
    });
  }

  return new Promise<TlsConnectResult>((done, fail) => {
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      servername: options.servername,
      rejectUnauthorized: options.rejectUnauthorized,
    });

    socket.setTimeout(10_000, () => {
      socket.destroy();
      fail(new Error(`TLS connection timed out on port ${options.port}`));
    });

    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to);
      const altNames = cert.subjectaltname
        ? cert.subjectaltname.split(', ').map((s) => s.replace(/^DNS:/, ''))
        : [cert.subject?.CN].filter(Boolean) as string[];
      socket.end();
      done({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
        validTo,
        subjectAltNames: altNames,
      });
    });

    socket.on('error', fail);
  });
};

const defaultSmtpProbe = async (options: {
  host: string;
  port: number;
  mailFrom: string;
  rcptTo: string;
}): Promise<SmtpProbeResult> => {
  return new Promise<SmtpProbeResult>((done, fail) => {
    const socket = net.connect({ host: options.host, port: options.port }, () => {
      let buffer = '';
      let step = 'banner';

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        if (step === 'banner' && buffer.includes('\r\n')) {
          buffer = '';
          step = 'ehlo';
          socket.write('EHLO preflight.test\r\n');
        } else if (step === 'ehlo' && buffer.includes('250 ') && buffer.includes('\r\n')) {
          buffer = '';
          step = 'mail_from';
          socket.write(`MAIL FROM:<${options.mailFrom}>\r\n`);
        } else if (step === 'mail_from' && buffer.includes('\r\n')) {
          const code = parseInt(buffer.slice(0, 3), 10);
          if (code >= 400) {
            socket.end('QUIT\r\n');
            done({ rejected: true, statusCode: code, response: buffer.trim() });
            return;
          }
          buffer = '';
          step = 'rcpt_to';
          socket.write(`RCPT TO:<${options.rcptTo}>\r\n`);
        } else if (step === 'rcpt_to' && buffer.includes('\r\n')) {
          const code = parseInt(buffer.slice(0, 3), 10);
          socket.end('QUIT\r\n');
          const isRejected = code >= 500 && code < 600;
          done({ rejected: isRejected, statusCode: code, response: buffer.trim() });
        }
      });
    });

    socket.setTimeout(10_000, () => {
      socket.destroy();
      fail(new Error('SMTP probe connection timed out'));
    });
    socket.on('error', fail);
  });
};

export async function runMailserverPreflight(options: MailserverPreflightOptions): Promise<PreflightReport> {
  const {
    domain,
    mailHost,
    dkimSelector = 'mail',
    ports = { smtps: 465, submission: 587, imaps: 993 },
    dnsLookup = {},
    tlsConnect = defaultTlsConnect,
    smtpProbe = defaultSmtpProbe,
  } = options;

  const checks: PreflightCheckResult[] = [];
  const dnsProbes: Required<DnsProbes> = {
    resolveA: dnsLookup.resolveA ?? defaultDns.resolveA,
    resolveAaaa: dnsLookup.resolveAaaa ?? defaultDns.resolveAaaa,
    resolveMx: dnsLookup.resolveMx ?? defaultDns.resolveMx,
    resolveTxt: dnsLookup.resolveTxt ?? defaultDns.resolveTxt,
    resolvePtr: dnsLookup.resolvePtr ?? defaultDns.resolvePtr,
  };

  // 1. Syntax Validation
  const validDomain = isValidFqdn(domain);
  checks.push({
    category: 'syntax',
    name: 'domain_fqdn_syntax',
    passed: validDomain,
    details: validDomain ? `Domain "${domain}" is a valid FQDN` : `Domain "${domain}" is not a valid FQDN`,
  });

  const validMailHost = isValidFqdn(mailHost);
  checks.push({
    category: 'syntax',
    name: 'mail_host_fqdn_syntax',
    passed: validMailHost,
    details: validMailHost ? `Mail host "${mailHost}" is a valid FQDN` : `Mail host "${mailHost}" is not a valid FQDN`,
  });

  if (!validDomain || !validMailHost) {
    return { domain, mailHost, passed: false, checks };
  }

  const cleanDomain = domain.trim().toLowerCase().replace(/\.$/, '');
  const cleanMailHost = mailHost.trim().toLowerCase().replace(/\.$/, '');

  // 2. DNS Checks
  // 2a. A / AAAA resolution for mailHost
  const aRecords = await dnsProbes.resolveA(cleanMailHost);
  const aaaaRecords = await dnsProbes.resolveAaaa(cleanMailHost);
  const allIps = [...aRecords, ...aaaaRecords];
  const hasIp = allIps.length > 0;
  checks.push({
    category: 'dns',
    name: 'mail_host_a_aaaa_records',
    passed: hasIp,
    details: hasIp
      ? `Mail host resolves to: ${allIps.join(', ')}`
      : `Mail host "${cleanMailHost}" has no A or AAAA records`,
  });

  // 2b. MX record check
  const mxRecords = await dnsProbes.resolveMx(cleanDomain);
  const matchingMx = mxRecords.find(
    (mx) => mx.exchange.trim().toLowerCase().replace(/\.$/, '') === cleanMailHost,
  );
  checks.push({
    category: 'dns',
    name: 'domain_mx_record',
    passed: Boolean(matchingMx),
    details: matchingMx
      ? `MX record points to ${matchingMx.exchange} (priority ${matchingMx.priority})`
      : `No MX record for "${cleanDomain}" points to "${cleanMailHost}". Found: ${mxRecords.map((m) => m.exchange).join(', ') || 'none'}`,
  });

  // 2c. PTR check
  if (hasIp) {
    const firstIp = allIps[0];
    const ptrRecords = await dnsProbes.resolvePtr(firstIp);
    const ptrMatches = ptrRecords.some(
      (ptr) => ptr.trim().toLowerCase().replace(/\.$/, '') === cleanMailHost,
    );
    checks.push({
      category: 'dns',
      name: 'mail_host_ptr_record',
      passed: ptrMatches,
      details: ptrMatches
        ? `PTR record for ${firstIp} matches ${cleanMailHost}`
        : `PTR record for ${firstIp} does not match ${cleanMailHost}. Found: ${ptrRecords.join(', ') || 'none'}`,
    });
  }

  // 2d. SPF check
  const domainTxtRecords = (await dnsProbes.resolveTxt(cleanDomain)).map((chunk) => chunk.join(''));
  const spfRecord = domainTxtRecords.find((txt) => txt.toLowerCase().startsWith('v=spf1'));
  checks.push({
    category: 'dns',
    name: 'domain_spf_record',
    passed: Boolean(spfRecord),
    details: spfRecord
      ? `SPF TXT record found: "${spfRecord}"`
      : `No SPF TXT record ("v=spf1...") found for "${cleanDomain}"`,
  });

  // 2e. DKIM check
  const dkimHost = `${dkimSelector}._domainkey.${cleanDomain}`;
  const dkimTxtRecords = (await dnsProbes.resolveTxt(dkimHost)).map((chunk) => chunk.join(''));
  const dkimRecord = dkimTxtRecords.find((txt) => txt.includes('v=DKIM1') || txt.includes('p='));
  checks.push({
    category: 'dns',
    name: 'domain_dkim_record',
    passed: Boolean(dkimRecord),
    details: dkimRecord
      ? `DKIM TXT record found at ${dkimHost}: "${dkimRecord}"`
      : `No DKIM TXT record found at "${dkimHost}"`,
  });

  // 2f. DMARC check
  const dmarcHost = `_dmarc.${cleanDomain}`;
  const dmarcTxtRecords = (await dnsProbes.resolveTxt(dmarcHost)).map((chunk) => chunk.join(''));
  const dmarcRecord = dmarcTxtRecords.find((txt) => txt.toLowerCase().startsWith('v=dmarc1'));
  checks.push({
    category: 'dns',
    name: 'domain_dmarc_record',
    passed: Boolean(dmarcRecord),
    details: dmarcRecord
      ? `DMARC TXT record found: "${dmarcRecord}"`
      : `No DMARC TXT record ("v=DMARC1...") found at "${dmarcHost}"`,
  });

  // 3. TLS Chain Verification on Ports
  const targetPorts = [
    { name: 'smtps', port: ports.smtps ?? 465, starttls: undefined },
    { name: 'smtp_submission_starttls', port: ports.submission ?? 587, starttls: 'smtp' as const },
    { name: 'imaps', port: ports.imaps ?? 993, starttls: undefined },
  ];

  for (const p of targetPorts) {
    try {
      const res = await tlsConnect({
        host: cleanMailHost,
        port: p.port,
        servername: cleanMailHost,
        rejectUnauthorized: true,
        starttls: p.starttls,
      });

      const now = Date.now();
      const expiresMs = res.validTo.getTime() - now;
      const minExpiryMs = 7 * 24 * 60 * 60 * 1000;
      const notExpired = expiresMs > 0;
      const hasSafeExpiry = expiresMs > minExpiryMs;
      const matchesSan = res.subjectAltNames.some((san) => matchesHostname(san, cleanMailHost));

      const passed = res.authorized && notExpired && hasSafeExpiry && matchesSan;
      const details = [
        res.authorized ? 'TLS chain authorized' : `TLS auth failed: ${res.authorizationError?.message ?? 'untrusted'}`,
        hasSafeExpiry ? `Valid until ${res.validTo.toISOString()}` : `Cert expired or expires in < 7 days (${res.validTo.toISOString()})`,
        matchesSan ? `SAN matches "${cleanMailHost}"` : `SAN mismatch (found: ${res.subjectAltNames.join(', ') || 'none'})`,
      ].join('; ');

      checks.push({
        category: 'tls',
        name: `tls_port_${p.port}_${p.name}`,
        passed,
        details,
      });
    } catch (err) {
      checks.push({
        category: 'tls',
        name: `tls_port_${p.port}_${p.name}`,
        passed: false,
        details: `Failed to connect or verify TLS on port ${p.port}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Open-relay rejection test
  try {
    const probeRes = await smtpProbe({
      host: cleanMailHost,
      port: ports.submission ?? 587,
      mailFrom: `unauth-probe@external-relay-test.example`,
      rcptTo: `victim@external-relay-destination.example`,
    });

    const isRejected = probeRes.rejected && [530, 550, 554, 501, 503, 521].includes(probeRes.statusCode);
    checks.push({
      category: 'relay',
      name: 'unauthenticated_open_relay_rejection',
      passed: isRejected,
      details: isRejected
        ? `Relay properly rejected with status ${probeRes.statusCode}: "${probeRes.response}"`
        : `CRITICAL: Server did not reject unauthenticated relay! Status: ${probeRes.statusCode}, Response: "${probeRes.response}"`,
    });
  } catch (err) {
    checks.push({
      category: 'relay',
      name: 'unauthenticated_open_relay_rejection',
      passed: false,
      details: 'Failed to test open-relay rejection probe',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    domain: cleanDomain,
    mailHost: cleanMailHost,
    passed: allPassed,
    checks,
  };
}

// Guarded CLI execution
function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  const executedPath = resolve(process.argv[1]);
  return scriptPath === executedPath || executedPath.endsWith('verify-mailserver-preflight.ts');
}

if (isDirectExecution()) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      domain: { type: 'string' },
      mailHost: { type: 'string' },
      selector: { type: 'string', default: 'mail' },
      smtpsPort: { type: 'string', default: '465' },
      submissionPort: { type: 'string', default: '587' },
      imapsPort: { type: 'string', default: '993' },
    },
    allowPositionals: true,
  });

  const domain = values.domain ?? positionals[0] ?? process.env.PREFLIGHT_DOMAIN;
  const mailHost = values.mailHost ?? positionals[1] ?? process.env.PREFLIGHT_MAIL_HOST;

  if (!domain || !mailHost) {
    console.error('Usage: verify-mailserver-preflight --domain <domain> --mailHost <mailHost> [--selector <dkimSelector>]');
    process.exit(1);
  }

  runMailserverPreflight({
    domain,
    mailHost,
    dkimSelector: values.selector,
    ports: {
      smtps: Number(values.smtpsPort),
      submission: Number(values.submissionPort),
      imaps: Number(values.imapsPort),
    },
  })
    .then((report) => {
      console.log(`\n=== Mailserver Preflight Report for ${report.domain} (${report.mailHost}) ===\n`);
      for (const check of report.checks) {
        const symbol = check.passed ? '✓ [PASS]' : '✗ [FAIL]';
        console.log(`${symbol} ${check.category.toUpperCase()} - ${check.name}: ${check.details}`);
        if (check.error) console.log(`    Error: ${check.error}`);
      }
      console.log(`\nOverall Status: ${report.passed ? 'ALL CHECKS PASSED' : 'PREFLIGHT CHECKS FAILED'}\n`);
      process.exit(report.passed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal preflight error:', err);
      process.exit(1);
    });
}
