import { PrismaClient } from '@prisma/client';

const shared = globalThis as typeof globalThis & { openInboxPrisma?: PrismaClient };
export const prisma = shared.openInboxPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') shared.openInboxPrisma = prisma;
