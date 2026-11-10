import { PrismaClient } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { recoverAbandonedImmediateExecution } from "../utils/ai/choose-rule/recover-execution";

// Operator-only: pnpm --filter @open-inbox-zero/web exec tsx scripts/recover-execution.ts
//   --account <id> --thread <id> --operator <name> --evidence <how the process was verified stopped>
async function main() {
  const { values } = parseArgs({ options: { account: { type: "string" }, thread: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" } } });
  if (!values.account || !values.thread || !values.operator || !values.evidence) throw new Error("Provide --account, --thread, --operator, and --evidence");
  if (!stdin.isTTY) throw new Error("Recovery requires an interactive terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try {
    confirmation = await terminal.question("Confirm you independently verified the original process and all its provider calls have stopped. Type STOPPED to continue: ");
  } finally { terminal.close(); }
  if (confirmation !== "STOPPED") throw new Error("Recovery cancelled");
  const prisma = new PrismaClient();
  try {
    const result = await recoverAbandonedImmediateExecution({ prisma, emailAccountId: values.account, threadId: values.thread, operator: values.operator, stoppedEvidence: values.evidence, confirmedStopped: true });
    console.log(`Recovery recorded: ${result.recoveryId}; affected executions: ${result.affectedExecutions}`);
  } finally { await prisma.$disconnect(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; });
