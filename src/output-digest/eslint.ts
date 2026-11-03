import { lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const SUMMARY = /^✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)$/u;
const ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/u;

/** The stylish formatter: a file path line, then one `line:col  severity  message  rule` row per problem. */
export function parseEslint(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures: DigestFailure[] = [];
  let file = '';
  for (const line of lines) {
    const row = ROW.exec(line);
    if (row === null) {
      if (line.length > 0 && !/^\s/u.test(line)) file = line;
      continue;
    }
    if (row[3] !== 'error') continue;
    failures.push({ name: row[5] === undefined ? row[4] : `${row[4]} (${row[5]})`, location: `${file}:${row[1]}:${row[2]}`, message: [] });
  }
  const counts = [{ label: 'errors', value: Number(summary[1]) }, { label: 'warnings', value: Number(summary[2]) }];
  return { tool: 'eslint', counts, failed: Number(summary[1]) > 0, failures };
}
