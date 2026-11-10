import { PrismaClient } from "@prisma/client";
import EmbeddedPostgres from "embedded-postgres";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoSeed } from "./seed-data";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = resolve(webDir, "../../.local-data");

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local database port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: webDir, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${signal ?? code}`)));
  });
}

/** Seed a new demo mailbox once. Existing accounts and their data are never reset. */
export async function seedDemo(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const account of demoSeed.accounts) {
      const existing = await tx.emailAccount.findUnique({ where: { email: account.email } });
      if (existing) {
        if (existing.provider !== "emulator") throw new Error(`The demo address ${account.email} is already in use by a non-emulator account`);
        continue;
      }
      const user = await tx.user.upsert({
        where: { email: account.email },
        create: { email: account.email, name: account.name },
        update: {},
      });
      const created = await tx.emailAccount.create({
        data: { id: account.id, userId: user.id, email: account.email, provider: account.provider },
      });
      for (const rule of demoSeed.rules) {
        await tx.rule.create({
          data: {
            name: rule.name,
            emailAccountId: created.id,
            systemType: rule.systemType,
            instructions: rule.instructions,
            from: rule.from,
            actions: { create: rule.actions },
          },
        });
      }
      for (const knowledge of demoSeed.knowledge) {
        await tx.knowledge.create({ data: { ...knowledge, emailAccountId: created.id } });
      }
      for (const memory of demoSeed.replyMemories) {
        await tx.replyMemory.create({ data: { ...memory, emailAccountId: created.id } });
      }
      for (const message of demoSeed.messages.filter((item) => item.accountId === account.id)) {
        await tx.emailMessage.create({
          data: {
            emailAccountId: created.id,
            threadId: message.threadId,
            messageId: message.id,
            fromEmail: message.fromEmail,
            fromName: message.fromName,
            toEmail: message.toEmail,
            subject: message.subject,
            snippet: message.textBody.slice(0, 160),
            textBody: message.textBody,
            internalDate: new Date(message.internalDate),
            labels: message.labels,
            unread: message.unread,
            archived: message.archived,
            listUnsubscribe: message.listUnsubscribe,
            listUnsubscribePost: message.listUnsubscribePost,
          },
        });
      }
    }
  }, { timeout: 30_000 });
}

async function main(): Promise<void> {
  let database: EmbeddedPostgres | undefined;
  let databaseStarted = false;
  let app: ChildProcess | undefined;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (app && app.exitCode === null && app.signalCode === null) {
      const runningApp = app;
      const stopped = new Promise<void>((resolveStop) => runningApp.once("exit", () => resolveStop()));
      runningApp.kill("SIGTERM");
      await stopped;
    }
    if (databaseStarted && database) await database.stop();
  };

  const handleSignal = () => {
    void shutdown().then(() => { process.exitCode = 0; }).catch((error: unknown) => {
      console.error("Could not stop local services:", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      await mkdir(localDir, { recursive: true, mode: 0o700 });
      const dataDir = resolve(localDir, "postgres");
      const passwordPath = resolve(localDir, "postgres-password");
      const initialized = await exists(resolve(dataDir, "PG_VERSION"));
      if (initialized && !(await exists(passwordPath))) {
        throw new Error("The local database password is missing; restore .local-data/postgres-password to reopen the existing database.");
      }
      if (!(await exists(passwordPath))) {
        await writeFile(passwordPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      }
      const password = (await readFile(passwordPath, "utf8")).trim();
      const port = await availablePort();
      database = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "postgres",
        password,
        port,
        persistent: true,
        authMethod: "scram-sha-256",
        postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
        autoRehydrateSymlinks: true,
      });
      if (!initialized) await database.initialise();
      await database.start();
      databaseStarted = true;
      databaseUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres?schema=public`;
    }

    const env = { ...process.env, DATABASE_URL: databaseUrl };
    process.env.DATABASE_URL = databaseUrl;
    await run("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], env);
    const prisma = new PrismaClient();
    try { await seedDemo(prisma); } finally { await prisma.$disconnect(); }
    if (shuttingDown) return;
    console.log("Local demo accounts are ready: developer@example.com and developer@outlook.test");
    await new Promise<void>((resolveApp, reject) => {
      app = spawn("pnpm", ["exec", "next", "dev"], { cwd: webDir, env, stdio: "inherit" });
      app.once("error", reject);
      app.once("exit", (code, signal) => {
        if (shuttingDown || code === 0) resolveApp();
        else reject(new Error(`Web server exited with ${signal ?? code}`));
      });
    });
  } finally {
    await shutdown();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("Local startup failed:", error);
    process.exitCode = 1;
  });
}
