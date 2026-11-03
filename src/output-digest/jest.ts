import { countOf, countPairs, dedent, lastMatch, projectFrameLocation, uniqueFailures } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const TESTS_LINE = /^Tests:\s+(?:(.+), )?(\d+) total$/u;
const SUITES_LINE = /^Test Suites:\s+(?:(.+), )?(\d+) total$/u;
const SUITE_HEADER = /^(?:FAIL|PASS) (\S.*)$/u;
const FAILURE_HEADER = /^\s+● (.+)$/u;
const CODE_OR_STACK = /^\s*>?\s*\d+ \||^\s+\||^\s+at /u;

function endsBlock(line: string): boolean {
  return FAILURE_HEADER.test(line) || SUITE_HEADER.test(line) || SUITES_LINE.test(line) || TESTS_LINE.test(line);
}

function readFailure(lines: readonly string[], start: number, name: string, suite: string | null): DigestFailure {
  let end = start;
  while (end < lines.length && !endsBlock(lines[end])) end += 1;
  const block = lines.slice(start, end);
  const detailEnd = block.findIndex((line) => CODE_OR_STACK.test(line));
  const frame = block.map(projectFrameLocation).find((location) => location !== null) ?? null;
  return { name, location: frame ?? suite, message: dedent(detailEnd === -1 ? block : block.slice(0, detailEnd)) };
}

export function parseJest(lines: readonly string[]): ToolDigest | null {
  const tests = lastMatch(lines, TESTS_LINE);
  const suites = lastMatch(lines, SUITES_LINE);
  if (tests === null || suites === null) return null;
  const testCounts = countPairs(tests[1] ?? '');
  const failures: DigestFailure[] = [];
  let suite: string | null = null;
  lines.forEach((line, index) => {
    suite = SUITE_HEADER.exec(line)?.[1] ?? suite;
    const name = FAILURE_HEADER.exec(line)?.[1];
    if (name !== undefined) failures.push(readFailure(lines, index + 1, name, suite));
  });
  const failed = countOf(testCounts, 'failed') > 0 || countOf(countPairs(suites[1] ?? ''), 'failed') > 0;
  return { tool: 'jest', counts: [{ label: 'tests', value: Number(tests[2]) }, ...testCounts], failed, failures: uniqueFailures(failures) };
}
