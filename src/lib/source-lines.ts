import { readFileSync, statSync } from 'node:fs';
import { decodeSourceText, detectEncoding } from './text-encoding.ts';

/** Largest file `read` opens; line counts stop at the same limit. */
export const READ_MAX_BYTES = 2_000_000;

/** What a file holds for line purposes: decoded lines, unreadable bytes, or a size over the read limit. */
export type FileLines =
  | { kind: 'text'; lines: string[] }
  | { kind: 'binary' }
  | { kind: 'too_large'; bytes: number };

/** A trailing newline ends the last line rather than starting an empty one; empty text has no lines. */
export function splitSourceLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

export function describeFileLines(absolutePath: string): FileLines {
  const bytes = statSync(absolutePath).size;
  if (bytes > READ_MAX_BYTES) return { kind: 'too_large', bytes };
  const buffer = readFileSync(absolutePath);
  if (detectEncoding(buffer) === 'utf8' && buffer.includes(0)) return { kind: 'binary' };
  return { kind: 'text', lines: splitSourceLines(decodeSourceText(buffer)) };
}

export function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}

/** The suffix `find` and `ls` put after a file name. */
export function formatFileLines(fileLines: FileLines): string {
  if (fileLines.kind === 'binary') return '(binary)';
  if (fileLines.kind === 'too_large') return `(${fileLines.bytes.toLocaleString('en-US')} bytes; too large to read)`;
  return `(${formatLineCount(fileLines.lines.length)})`;
}
