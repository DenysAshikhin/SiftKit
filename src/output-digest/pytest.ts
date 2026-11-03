import { countOf, countPairs, dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const FINAL_LINE = /^=+ (.+) in [\d.]+s(?: \([^)]*\))? =+$/u;
const BLOCK_HEADING = /^=+ (.+?) =+$/u;
const SECTION_TITLE = /^_{3,} (.+?) _{3,}$/u;
const ERROR_LINE = /^E(?: |$)/u;
const LOCATION_LINE = /^(\S.*?\.py:\d+): /u;
const SUMMARY_LINE = /^(?:FAILED|ERROR) (\S+)(?: - (.*))?$/u;

function readSection(lines: readonly string[], name: string): DigestFailure {
  const location = lastMatch(lines, LOCATION_LINE)?.[1] ?? null;
  return { name, location, message: dedent(lines.filter((line) => ERROR_LINE.test(line)).map((line) => line.slice(1))) };
}

/** Each failure section under the FAILURES and ERRORS headings, named by its title. */
function readSections(lines: readonly string[]): DigestFailure[] {
  const failures: DigestFailure[] = [];
  let inFailures = false;
  let title: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (title !== null) failures.push(readSection(body, title));
    title = null;
    body = [];
  };
  for (const line of lines) {
    const heading = BLOCK_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      close();
      inFailures = heading === 'FAILURES' || heading === 'ERRORS';
      continue;
    }
    if (!inFailures) continue;
    const sectionTitle = SECTION_TITLE.exec(line)?.[1];
    if (sectionTitle === undefined) {
      body.push(line);
      continue;
    }
    close();
    title = sectionTitle;
  }
  close();
  return failures;
}

export function parsePytest(lines: readonly string[]): ToolDigest | null {
  const final = lastMatch(lines, FINAL_LINE);
  if (final === null) return null;
  const counts = countPairs(final[1]);
  const sections = readSections(lines);
  // With `--tb=no` there are no sections; the short summary still names each failure.
  const failures = sections.length > 0 ? sections : lines.flatMap((line) => {
    const match = SUMMARY_LINE.exec(line);
    return match === null ? [] : [{ name: match[1], location: null, message: match[2] === undefined ? [] : [match[2]] }];
  });
  const failed = countOf(counts, 'failed') + countOf(counts, 'error') + countOf(counts, 'errors') > 0;
  return { tool: 'pytest', counts, failed, failures };
}
