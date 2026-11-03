import type { DigestCount, DigestFailure } from './types.ts';

// CSI colour codes and OSC sequences (MSBuild's progress and hyperlink codes) end with BEL or ESC \.
const TERMINAL_CODE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/gu;
const STACK_FRAME = /^\s*at (?:.+ \()?(?:file:\/\/\/)?(.+?:\d+:\d+)\)?(?: \{)?$/u;
const COUNT_PAIR = /(\d+) ([a-z]+)/gu;

export function stripTerminalCodes(text: string): string {
  return text.replace(TERMINAL_CODE, '');
}

/** Drops blank lines and the indentation every remaining line shares. */
export function dedent(lines: readonly string[]): string[] {
  const kept = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...kept.map((line) => line.length - line.trimStart().length));
  return kept.map((line) => line.slice(indent));
}

/** The `file:line:col` of a JS stack frame outside node internals and node_modules, or null. */
export function projectFrameLocation(line: string): string | null {
  const location = STACK_FRAME.exec(line)?.[1];
  if (location === undefined || location.startsWith('node:') || location.includes('node_modules')) return null;
  return location;
}

export function firstMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) return match;
  }
  return null;
}

/** The last line matching `pattern`; a summary line printed twice counts once, as its final form. */
export function lastMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) return match;
  }
  return null;
}

/** `3 failed, 1 passed` or `3 failed | 1 passed` as counts, in printed order. */
export function countPairs(text: string): DigestCount[] {
  return [...text.matchAll(COUNT_PAIR)].map((match) => ({ label: match[2], value: Number(match[1]) }));
}

export function countOf(counts: readonly DigestCount[], label: string): number {
  return counts.filter((count) => count.label === label).reduce((sum, count) => sum + count.value, 0);
}

/** One failure per name and location; reporters such as MSBuild and Jest repeat them in a summary. */
export function uniqueFailures(failures: readonly DigestFailure[]): DigestFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.name}\n${failure.location ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
