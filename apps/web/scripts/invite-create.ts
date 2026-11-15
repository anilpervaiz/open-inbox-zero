import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { createMailboxInvitation } from '../utils/auth/invitations';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must identify the database');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    email: { type: 'string' },
    admin: { type: 'string', default: 'cli-admin' },
    ttl: { type: 'string' },
  },
  allowPositionals: true,
});

const email = values.email ?? positionals[0];
if (!email) {
  console.error('Usage: invite-create --email <email> [--admin <actor>] [--ttl <hours>]');
  process.exit(1);
}

const ttlHours = values.ttl ? Number(values.ttl) : undefined;
const prisma = new PrismaClient();

try {
  const result = await createMailboxInvitation({
    prisma,
    email,
    adminActor: values.admin ?? 'cli-admin',
    ttlHours,
  });
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
