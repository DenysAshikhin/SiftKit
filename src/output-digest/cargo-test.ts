import { dedent } from './lines.ts';
import type { DigestCount, DigestFailure, ToolDigest } from './types.ts';

const RESULT_LINE = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/u;
const STDOUT_HEADING = /^---- (\S+) stdout ----$/u;
const PANIC_LINE = /^thread '.*?' (?:\(\d+\) )?panicked at (.+:\d+:\d+):$/u;
const PANIC_END = /^(?:note: |---- |failures:$|\s*$)/u;
const RUSTC_DIAGNOSTIC = /^(error|warning)(?:\[(E\d+)\])?: (.*)$/u;
const RUSTC_LOCATION = /^\s*--> (.+:\d+:\d+)$/u;

/** A failing test's panic location and message, which runs to a blank line or rustc's backtrace note. */
function readPanic(lines: readonly string[], start: number, name: string): DigestFailure {
  let index = start;
  while (index < lines.length && !PANIC_LINE.test(lines[index]) && !STDOUT_HEADING.test(lines[index])) index += 1;
  const panic = index < lines.length ? PANIC_LINE.exec(lines[index]) : null;
  if (panic === null) return { name, location: null, message: [] };
  let end = index + 1;
  while (end < lines.length && !PANIC_END.test(lines[end])) end += 1;
  return { name, location: panic[1], message: dedent(lines.slice(index + 1, end)) };
}

export function parseCargoTest(lines: readonly string[]): ToolDigest | null {
  const totals = { passed: 0, failed: 0, ignored: 0 };
  let results = 0;
  const failures: DigestFailure[] = [];
  let errors = 0;
  let warnings = 0;
  lines.forEach((line, index) => {
    const result = RESULT_LINE.exec(line);
    if (result !== null) {
      results += 1;
      totals.passed += Number(result[1]);
      totals.failed += Number(result[2]);
      totals.ignored += Number(result[3]);
    }
    const heading = STDOUT_HEADING.exec(line);
    if (heading !== null) failures.push(readPanic(lines, index + 1, heading[1]));
    // Only a diagnostic with a `-->` location is rustc's; cargo's own `error:` lines have none.
    const diagnostic = RUSTC_DIAGNOSTIC.exec(line);
    const location = diagnostic === null ? null : RUSTC_LOCATION.exec(lines[index + 1] ?? '');
    if (diagnostic === null || location === null) return;
    if (diagnostic[1] === 'warning') {
      warnings += 1;
      return;
    }
    errors += 1;
    failures.push({ name: diagnostic[2] === undefined ? diagnostic[3] : `${diagnostic[2]}: ${diagnostic[3]}`, location: location[1], message: [] });
  });
  if (results === 0 && errors + warnings === 0) return null;
  const counts: DigestCount[] = [
    ...(results === 0 ? [] : Object.entries(totals).map(([label, value]) => ({ label, value }))),
    ...(errors + warnings === 0 ? [] : [{ label: 'errors', value: errors }, { label: 'warnings', value: warnings }]),
  ];
  return { tool: 'cargo test', counts, failed: totals.failed > 0 || errors > 0, failures };
}
