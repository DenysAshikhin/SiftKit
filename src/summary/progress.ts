import { formatTimestamp } from '../lib/text-format.js';

export function logSummaryProgress(message: string): void {
  process.stdout.write(`${formatTimestamp()} summary ${message}\n`);
}
