import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { seedDemo } from "../scripts/local-dev";

const execFileAsync = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port available");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

test("seeds a real PostgreSQL database once without resetting user changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-inbox-zero-test-"));
  const port = await availablePort();
  const database = new EmbeddedPostgres({
    databaseDir: join(dir, "postgres"), user: "postgres", password: "temporary-test-password",
    port, persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    autoRehydrateSymlinks: true, onLog: () => undefined,
  });
  let started = false;
  let prisma: PrismaClient | undefined;
  try {
    await database.initialise();
    await database.start();
    started = true;
    const url = `postgresql://postgres:temporary-test-password@127.0.0.1:${port}/postgres?schema=public`;
    await execFileAsync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], {
      cwd: webDir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedDemo(prisma);
    expect(await prisma.emailAccount.count()).toBe(2);
    expect(await prisma.rule.count()).toBe(12);
    expect(await prisma.knowledge.count()).toBe(6);
    expect(await prisma.replyMemory.count()).toBe(6);
    expect(await prisma.emailMessage.count()).toBe(25);
    await prisma.emailMessage.update({
      where: { emailAccountId_messageId: { emailAccountId: "demo-gmail", messageId: "demo-message-01" } },
      data: { archived: true },
    });
    await seedDemo(prisma);
    expect(await prisma.emailMessage.count()).toBe(25);
    expect((await prisma.emailMessage.findUniqueOrThrow({
      where: { emailAccountId_messageId: { emailAccountId: "demo-gmail", messageId: "demo-message-01" } },
    })).archived).toBe(true);
  } finally {
    await prisma?.$disconnect();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
