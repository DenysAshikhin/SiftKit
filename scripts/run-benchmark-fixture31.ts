import * as path from 'node:path';
import { runDebugRequest } from './run-benchmark-fixture-debug.js';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const result = await runDebugRequest([
    '--fixture-root', path.join(repoRoot, 'eval', 'fixtures', 'ai_core_60_tests'),
    '--fixture-index', '31',
    '--trace-summary', '1',
    ...process.argv.slice(2),
  ]);
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
