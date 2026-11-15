import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { prisma } from '../server/prisma';

/** Missing configuration leaves public sign-in closed; it never invents a production secret. */
export function authConfiguration(env: Record<string, string | undefined> = process.env) {
  const secret = env.BETTER_AUTH_SECRET;
  const rawUrl = env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32 || !rawUrl) return null;
  let base: URL;
  try { base = new URL(rawUrl); } catch { return null; }
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) return null;
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) return null;
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, accessType: 'offline' as const, scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'], prompt: 'consent' as const } : undefined;
  const microsoft = env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: 'common', scope: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access'] } : undefined;
  const selfHosted = Boolean(env.SELF_HOSTED_MAIL_DOMAIN || env.SELF_HOSTED_IMAP_HOST || env.SELF_HOSTED_AUTH_ENABLED === 'true');
  if (!google && !microsoft && !selfHosted) return null;
  return { secret, baseUrl: base.origin, google, microsoft, selfHosted };
}

export function createSessionAuth(configuration: NonNullable<ReturnType<typeof authConfiguration>>, db = prisma) {
  return betterAuth({
    secret: configuration.secret,
    baseURL: configuration.baseUrl,
    trustedOrigins: [configuration.baseUrl],
    database: prismaAdapter(db, { provider: 'postgresql' }),
    session: { modelName: 'authSession' },
    account: { modelName: 'authAccount', encryptOAuthTokens: true, accountLinking: { disableImplicitLinking: true, allowDifferentEmails: true } },
    verification: { modelName: 'authVerification' },
    emailAndPassword: { enabled: true, disableSignUp: true },
    socialProviders: { ...(configuration.google ? { google: configuration.google } : {}), ...(configuration.microsoft ? { microsoft: configuration.microsoft } : {}) },
    advanced: { useSecureCookies: configuration.baseUrl.startsWith('https://') },
  });
}

let cached: ReturnType<typeof createSessionAuth> | undefined;
export function getSessionAuth() {
  const configuration = authConfiguration();
  if (!configuration) return null;
  return cached ??= createSessionAuth(configuration);
}
