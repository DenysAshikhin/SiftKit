import { dedent, projectFrameLocation } from './lines.ts';
import type { DigestCount, DigestFailure, ToolDigest } from './types.ts';

const COUNT_LABELS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const COUNT_LINE = new RegExp(`^ℹ (${COUNT_LABELS.join('|')}) (\\d+)$`, 'u');
const FAILING_HEADING = '✖ failing tests:';
const DECLARED_AT = /^test at (.+)$/u;
const RESULT_LINE = /^✖ (.+) \(\d+(?:\.\d+)?ms\)$/u;
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

export function parseNodeTest(lines: readonly string[]): ToolDigest | null {
  const values = new Map<string, number>();
  for (const line of lines) {
    const match = COUNT_LINE.exec(line);
    if (match !== null) values.set(match[1], Number(match[2]));
  }
  if (!values.has('tests') || !values.has('pass')) return null;
  const counts: DigestCount[] = COUNT_LABELS.flatMap((label) => {
    const value = values.get(label);
    return value === undefined ? [] : [{ label, value }];
  });
  const failures: DigestFailure[] = [];
  const section = lines.lastIndexOf(FAILING_HEADING);
  let declared: string | null = null;
  for (let index = section === -1 ? lines.length : section + 1; index < lines.length; index += 1) {
    const declaredMatch = DECLARED_AT.exec(lines[index]);
    if (declaredMatch !== null) declared = declaredMatch[1];
    const result = RESULT_LINE.exec(lines[index]);
    if (result === null) continue;
    let end = index + 1;
    while (end < lines.length && !DECLARED_AT.test(lines[end])) end += 1;
    failures.push(readFailure(lines, lines.slice(index + 1, end), lines[index], result[1], declared));
    index = end - 1;
  }
  const failed = (values.get('fail') ?? 0) > 0 || (values.get('cancelled') ?? 0) > 0;
  return { tool: 'node:test', counts, failed, failures };
}
