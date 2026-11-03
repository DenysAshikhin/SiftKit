import type { DigestFailure, ToolDigest } from './types.ts';

// `--pretty false` prints `file(line,col): error`; the default pretty form prints `file:line:col - error`.
const PLAIN = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/u;
const PRETTY = /^(.+):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/u;

export function parseTsc(lines: readonly string[]): ToolDigest | null {
  const diagnostics = lines.flatMap((line) => {
    const match = PLAIN.exec(line) ?? PRETTY.exec(line);
    return match === null ? [] : [{ severity: match[4], failure: { name: `${match[5]}: ${match[6]}`, location: `${match[1]}:${match[2]}:${match[3]}`, message: [] } }];
  });
  if (diagnostics.length === 0) return null;
  const failures: DigestFailure[] = diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.failure);
  const counts = [{ label: 'errors', value: failures.length }, { label: 'warnings', value: diagnostics.length - failures.length }];
  return { tool: 'tsc', counts, failed: failures.length > 0, failures };
}
