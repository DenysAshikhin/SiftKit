import { dedent, projectFrameLocation } from './lines.ts';
import type { DigestCount, DigestFailure, ToolDigest } from './types.ts';

const COUNT_LABELS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const COUNT_LINE = new RegExp(`^ℹ (${COUNT_LABELS.join('|')}) (\\d+)$`, 'u');
const FAILING_HEADING = '✖ failing tests:';
const DECLARED_AT = /^test at (.+)$/u;
const RESULT_LINE = /^✖ (.+) \(\d+(?:\.\d+)?ms\)$/u;
const PASS_LINE = /^✔ .+ \(\d+(?:\.\d+)?ms\)$/u;
const ANY_RESULT_LINE = /^\s*(?:✔|✖|﹣|▶|ℹ) /u;
const STACK_LINE = /^\s+at /u;
const LOAD_ERROR = /^(?:[A-Z]\w*)?Error\b/u;
const FILE_URL = /^file:\/\/\/(.+:\d+)$/u;
const BARE_FAILURE = "'test failed'";

/** node prints a file that fails to load as `'test failed'`; its real error comes before the file's first result line. */
function loadError(lines: readonly string[], resultLine: string): { location: string | null; message: string[] } | null {
  const end = lines.indexOf(resultLine);
  let start = end;
  while (start > 0 && !ANY_RESULT_LINE.test(lines[start - 1])) start -= 1;
  const block = lines.slice(start, end);
  const error = block.find((line) => LOAD_ERROR.test(line));
  if (error === undefined) return null;
  const location = block.map((line) => FILE_URL.exec(line)?.[1]).find((match) => match !== undefined) ?? null;
  return { location, message: [error] };
}

function readFailure(lines: readonly string[], body: readonly string[], resultLine: string, name: string, declared: string | null): DigestFailure {
  const stackStart = body.findIndex((line) => STACK_LINE.test(line));
  const message = dedent(stackStart === -1 ? body : body.slice(0, stackStart));
  const frame = body.map(projectFrameLocation).find((location) => location !== null) ?? null;
  const loaded = message.length === 1 && message[0] === BARE_FAILURE ? loadError(lines, resultLine) : null;
  if (loaded !== null) return { name, location: loaded.location ?? declared, message: loaded.message };
  return { name, location: frame ?? declared, message };
}

/** Each `ℹ tests` line opens one run's summary block; a block without `pass` is not node's summary. */
function summaryBlocks(lines: readonly string[]): Map<string, number>[] {
  const blocks: Map<string, number>[] = [];
  for (const line of lines) {
    const match = COUNT_LINE.exec(line);
    if (match === null) continue;
    if (match[1] === 'tests') blocks.push(new Map());
    blocks.at(-1)?.set(match[1], Number(match[2]));
  }
  return blocks.filter((block) => block.has('tests') && block.has('pass'));
}

/** A failure's body is the indented or blank lines under its `✖` line. */
function isBodyLine(line: string): boolean {
  return line.trim() === '' || /^\s/u.test(line);
}

/** A `✖ failing tests:` section ends at the first line that is not a failure, its `test at` line, or its body. */
function sectionEnd(lines: readonly string[], heading: number): number {
  let end = heading + 1;
  while (end < lines.length && (isBodyLine(lines[end]) || DECLARED_AT.test(lines[end]) || RESULT_LINE.test(lines[end]))) end += 1;
  return end;
}

/** Every `✖` failure in `[start, end)`, each with the `test at` location declared before it. */
function readFailures(lines: readonly string[], start: number, end: number): DigestFailure[] {
  const failures: DigestFailure[] = [];
  let declared: string | null = null;
  for (let index = start; index < end; index += 1) {
    const declaredMatch = DECLARED_AT.exec(lines[index]);
    if (declaredMatch !== null) declared = declaredMatch[1];
    const result = RESULT_LINE.exec(lines[index]);
    if (result === null) continue;
    let bodyEnd = index + 1;
    while (bodyEnd < end && isBodyLine(lines[bodyEnd])) bodyEnd += 1;
    failures.push(readFailure(lines, lines.slice(index + 1, bodyEnd), lines[index], result[1], declared));
    index = bodyEnd - 1;
  }
  return failures;
}

/** Output cut before node's summary (a tail, a filter, a killed run): a `✖` result proves a failure; counts are only what was seen. */
function unsummarisedDigest(lines: readonly string[], sectionFailures: DigestFailure[]): ToolDigest | null {
  const failedNames = new Set(lines.flatMap((line) => RESULT_LINE.exec(line)?.[1] ?? []));
  if (failedNames.size === 0) return null;
  return {
    tool: 'node:test',
    counts: [{ label: 'pass seen', value: lines.filter((line) => PASS_LINE.test(line)).length }, { label: 'fail seen', value: failedNames.size }],
    failed: true,
    failures: sectionFailures.length > 0 ? sectionFailures : readFailures(lines, 0, lines.length),
  };
}

/** One output may hold several runs (`a; b`): their counts are summed and every failing section is read. */
export function parseNodeTest(lines: readonly string[]): ToolDigest | null {
  const blocks = summaryBlocks(lines);
  const headings = lines.flatMap((line, index) => (line === FAILING_HEADING ? [index] : []));
  const sectionFailures = headings.flatMap((heading) => readFailures(lines, heading + 1, sectionEnd(lines, heading)));
  if (blocks.length === 0) return unsummarisedDigest(lines, sectionFailures);
  const counts: DigestCount[] = COUNT_LABELS.flatMap((label) => {
    const values = blocks.flatMap((block) => block.get(label) ?? []);
    return values.length === 0 ? [] : [{ label, value: values.reduce((sum, value) => sum + value, 0) }];
  });
  const total = (label: string): number => counts.find((count) => count.label === label)?.value ?? 0;
  return {
    tool: 'node:test',
    counts: blocks.length > 1 ? [...counts, { label: 'runs', value: blocks.length }] : counts,
    failed: total('fail') > 0 || total('cancelled') > 0,
    failures: sectionFailures,
  };
}
