import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
const schema = z.object({ generatedAt: z.iso.datetime(), adapter: z.string(), total: z.number().int().positive(), counts: z.object({ correct: z.number().int().nonnegative(), vipArchives: z.number().int().nonnegative(), sends: z.number().int().nonnegative() }), metrics: z.object({ ruleAccuracy: z.number(), coldEmailPrecision: z.number(), unsubscribeSafety: z.number(), vipFalseArchiveRate: z.number(), replyStateAccuracy: z.number(), unauthorizedSendRate: z.number() }) });
/** Return only aggregate data, never benchmark message text. */
export async function evaluationSummary() {
  try { return schema.parse(JSON.parse(await readFile(resolve(process.cwd(), 'data/eval-report.json'), 'utf8'))); }
  catch { return null; }
}
