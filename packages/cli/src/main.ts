import { runCli } from './index';

try {
  const result = await runCli(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
}
