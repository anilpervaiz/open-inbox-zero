import { PrismaClient } from '@prisma/client';
import { seedDemo } from './local-dev';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must identify the database to seed');
const prisma = new PrismaClient();
try { await seedDemo(prisma); console.log('Demo accounts are ready.'); }
finally { await prisma.$disconnect(); }
