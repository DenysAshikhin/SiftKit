import path from 'node:path';

import { z } from '../../src/lib/zod.js';
import { getErrorMessage } from '../../src/lib/errors.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import {
  RepoAgentHistoryRepairModeSchema,
  repairRepoAgentHistory,
} from '../../src/status-server/repo-agent-history-repair.js';

const USAGE = 'usage: repair-repo-agent-history --session <chat session id> [--apply] [--runtime-root <path>]';

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const sessionId = z.string().min(1, USAGE).parse(readFlagValue(argv, '--session') ?? '');
  // Dry-run is the default on purpose: this reads a real chat history, and the only way to write
  // to it is to ask for it after reading the report.
  const mode = RepoAgentHistoryRepairModeSchema.parse(argv.includes('--apply') ? 'apply' : 'dry-run');
  const runtimeRoot = readFlagValue(argv, '--runtime-root') ?? path.join(process.cwd(), '.siftkit');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const report = repairRepoAgentHistory(database, sessionId, mode);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
}
