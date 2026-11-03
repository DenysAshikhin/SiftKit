import { countOf, firstMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

// The classic logger and .NET 10's terminal logger print different summaries and failure headers.
const CLASSIC_SUMMARY = /^(?:Passed|Failed)!\s+- Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/u;
const TERMINAL_SUMMARY = /^Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/u;
const CLASSIC_FAILED = /^ {2}Failed (.+?) \[[^\]]*\]$/u;
const TERMINAL_FAILED = /^\s+(\S+) \([^)]*\): Error Message: (.*)$/u;
const TERMINAL_ERROR = /: error TESTERROR:/u;
const SOURCE_LINE = /\bin (.+):line (\d+)$/u;
const COUNT_LABELS = ['tests', 'failed', 'passed', 'skipped'] as const;

type Summary = Record<(typeof COUNT_LABELS)[number], number>;

function readSummary(line: string): Summary | null {
  const classic = CLASSIC_SUMMARY.exec(line);
  if (classic !== null) return { tests: Number(classic[4]), failed: Number(classic[1]), passed: Number(classic[2]), skipped: Number(classic[3]) };
  const terminal = TERMINAL_SUMMARY.exec(line);
  if (terminal !== null) return { tests: Number(terminal[1]), failed: Number(terminal[2]), passed: Number(terminal[3]), skipped: Number(terminal[4]) };
  return null;
}

function endsBlock(line: string): boolean {
  return line.trim().length === 0 || CLASSIC_FAILED.test(line) || TERMINAL_FAILED.test(line) || TERMINAL_ERROR.test(line);
}

/** The message runs to `Stack Trace:`; the first `in <file>:line N` frame below it is the location. */
function readFailure(lines: readonly string[], start: number, name: string, firstMessageLine: string | null): DigestFailure {
  let end = start;
  while (end < lines.length && !endsBlock(lines[end])) end += 1;
  const block = lines.slice(start, end).map((line) => line.trim());
  const stackStart = block.indexOf('Stack Trace:');
  const messageLines = (stackStart === -1 ? block : block.slice(0, stackStart)).filter((line) => line !== 'Error Message:');
  const source = firstMatch(block, SOURCE_LINE);
  return {
    name,
    location: source === null ? null : `${source[1]}:${source[2]}`,
    message: firstMessageLine === null ? messageLines : [firstMessageLine, ...messageLines],
  };
}

export function parseDotnetTest(lines: readonly string[]): ToolDigest | null {
  const summaries = lines.flatMap((line) => readSummary(line) ?? []);
  if (summaries.length === 0) return null;
  const counts = COUNT_LABELS.map((label) => ({ label, value: summaries.reduce((sum, summary) => sum + summary[label], 0) }));
  const failures = lines.flatMap((line, index) => {
    const classic = CLASSIC_FAILED.exec(line);
    if (classic !== null) return [readFailure(lines, index + 1, classic[1], null)];
    const terminal = TERMINAL_FAILED.exec(line);
    return terminal === null ? [] : [readFailure(lines, index + 1, terminal[1], terminal[2])];
  });
  return { tool: 'dotnet test', counts, failed: countOf(counts, 'failed') > 0, failures };
}
