import { dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const SUMMARY = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?\s*$/u;
const DIAGNOSTIC = /^(\s+)(.+:\d+:\d+) - (error|warning|information): (.*)$/u;

/** Each error with the lines indented under it, which carry the explanation and the rule. */
export function parsePyright(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures: DigestFailure[] = [];
  lines.forEach((line, index) => {
    const diagnostic = DIAGNOSTIC.exec(line);
    if (diagnostic === null || diagnostic[3] !== 'error') return;
    let end = index + 1;
    while (end < lines.length && lines[end].length - lines[end].trimStart().length > diagnostic[1].length && !DIAGNOSTIC.test(lines[end])) end += 1;
    failures.push({ name: diagnostic[4], location: diagnostic[2], message: dedent(lines.slice(index + 1, end)) });
  });
  const counts = [{ label: 'errors', value: Number(summary[1]) }, { label: 'warnings', value: Number(summary[2]) }];
  return { tool: 'pyright', counts, failed: Number(summary[1]) > 0, failures };
}
