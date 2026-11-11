import { PrismaClient } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { recoverAbandonedTrackerLock } from "../utils/worker/delayed-actions";

// Operator-only: pass --account <id> --job <id> --operator <name> --evidence <how shutdown was verified>.
async function main() {
  const { values } = parseArgs({ options: { account: { type: "string" }, job: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" } } });
  if (!values.account || !values.job || !values.operator || !values.evidence) throw new Error("Provide --account, --job, --operator, and --evidence");
  if (!stdin.isTTY) throw new Error("Recovery requires an interactive terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try { confirmation = await terminal.question("Confirm you independently verified the tracker worker has stopped. Type STOPPED to continue: "); }
  finally { terminal.close(); }
  if (confirmation !== "STOPPED") throw new Error("Recovery cancelled");
  const prisma = new PrismaClient();
  try {
    const result = await recoverAbandonedTrackerLock({ prisma, emailAccountId: values.account, delayedActionId: values.job, operator: values.operator, stoppedEvidence: values.evidence, confirmedStopped: true });
    console.log(`Recovery recorded: ${result.recoveryId}; tracking still pending: ${result.trackerPending}`);
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; });
