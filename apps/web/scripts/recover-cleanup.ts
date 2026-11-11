import { PrismaClient } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { recoverAbandonedCleanupJob } from "../utils/cleanup/cleanup-jobs";

// Operator-only: use --account <id> --job <id> --operator <name> --evidence <how shutdown was verified>.
async function main() {
  const { values } = parseArgs({ options: { account: { type: "string" }, job: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" } } });
  if (!values.account || !values.job || !values.operator || !values.evidence) throw new Error("Provide --account, --job, --operator, and --evidence");
  if (!stdin.isTTY) throw new Error("Recovery requires an interactive terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try { confirmation = await terminal.question("Confirm you independently verified the cleanup process and all its provider calls have stopped. Type STOPPED to continue: "); }
  finally { terminal.close(); }
  if (confirmation !== "STOPPED") throw new Error("Recovery cancelled");
  const prisma = new PrismaClient();
  try {
    const result = await recoverAbandonedCleanupJob({ prisma, emailAccountId: values.account, cleanupJobId: values.job, operator: values.operator, stoppedEvidence: values.evidence, confirmedStopped: true });
    console.log(`Recovery recorded: ${result.recoveryId}; released locks: ${result.releasedLocks}`);
  } finally { await prisma.$disconnect(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; });
