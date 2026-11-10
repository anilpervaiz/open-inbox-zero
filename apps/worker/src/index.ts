import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../web/scripts/delayed-worker";

export { emulatorProviderResolver, runDelayedWorker } from "../../web/scripts/delayed-worker";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("Delayed worker stopped unexpectedly"); process.exitCode = 1; });
}
