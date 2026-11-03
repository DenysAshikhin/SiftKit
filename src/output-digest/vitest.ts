import { countOf, countPairs, dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const FILES_LINE = /^\s*Test Files {2}(.+?)(?: \((\d+)\))?$/u;
const TESTS_LINE = /^\s*Tests {2}(.+?)(?: \((\d+)\))?$/u;
const FAIL_LINE = /^ FAIL {2}(.+)$/u;
const FRAME_LINE = /^ ❯ (\S+:\d+:\d+)$/u;
const SEPARATOR = /^⎯/u;

function readFailure(lines: readonly string[], start: number, name: string): DigestFailure {
  let end = start;
  while (end < lines.length && !SEPARATOR.test(lines[end]) && !FAIL_LINE.test(lines[end])) end += 1;
  const block = lines.slice(start, end);
  const frameIndex = block.findIndex((line) => FRAME_LINE.test(line));
  const location = frameIndex === -1 ? null : FRAME_LINE.exec(block[frameIndex])?.[1] ?? null;
  return { name, location, message: dedent(frameIndex === -1 ? block : block.slice(0, frameIndex)) };
}

export function parseVitest(lines: readonly string[]): ToolDigest | null {
  const files = lastMatch(lines, FILES_LINE);
  if (files === null) return null;
  const tests = lastMatch(lines, TESTS_LINE);
  const testCounts = tests === null ? [] : countPairs(tests[1]);
  const total = tests?.[2];
  const counts = total === undefined ? testCounts : [{ label: 'tests', value: Number(total) }, ...testCounts];
  const failures = lines.flatMap((line, index) => {
    const name = FAIL_LINE.exec(line)?.[1];
    return name === undefined ? [] : [readFailure(lines, index + 1, name)];
  });
  const failed = countOf(testCounts, 'failed') > 0 || countOf(countPairs(files[1]), 'failed') > 0;
  return { tool: 'vitest', counts, failed, failures };
}
