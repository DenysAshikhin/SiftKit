import { lastMatch } from './lines.ts';
import type { ToolDigest } from './types.ts';

// mypy always ends with one of these; requiring it keeps compilers' `file:line: error:` lines out.
const SUMMARY = /^(?:Found (\d+) errors? in \d+ files? \(checked (\d+) source files?\)|Success: no issues found in (\d+) source files?)$/u;
const ERROR_LINE = /^(.+?:\d+(?::\d+)?): error: (.*)$/u;

export function parseMypy(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures = lines.flatMap((line) => {
    const match = ERROR_LINE.exec(line);
    return match === null ? [] : [{ name: match[2], location: match[1], message: [] }];
  });
  const checked = Number(summary[2] ?? summary[3]);
  const counts = [{ label: 'errors', value: Number(summary[1] ?? 0) }, { label: 'source files checked', value: checked }];
  return { tool: 'mypy', counts, failed: summary[1] !== undefined, failures };
}
