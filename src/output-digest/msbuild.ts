import { diagnosticDigest } from './lines.ts';
import type { ToolDigest } from './types.ts';

// The classic logger ends `Build succeeded.`/`Build FAILED.`; the terminal logger ends `Build failed with N error(s) in 0.9s`.
const MARKER = /^Build (?:succeeded|FAILED)\.$|^Build (?:succeeded|failed)(?: with .+)? in [\d.]+s$/u;
// A coded diagnostic; `dotnet test`'s TESTERROR lines are test failures, which the dotnet test parser reads.
const DIAGNOSTIC = /^\s*(.+?)(?:\((\d+)(?:,(\d+))?\))?\s?: (error|warning) ([A-Z]+\d+): (.*?)(?: \[[^\]]+\])?$/u;

export function parseMsbuild(lines: readonly string[]): ToolDigest | null {
  if (!lines.some((line) => MARKER.test(line))) return null;
  const diagnostics = lines.flatMap((line) => {
    const match = DIAGNOSTIC.exec(line);
    if (match === null) return [];
    const location = match[2] === undefined ? match[1] : `${match[1]}:${match[2]}${match[3] === undefined ? '' : `:${match[3]}`}`;
    return [{ severity: match[4], failure: { name: `${match[5]}: ${match[6]}`, location, message: [] } }];
  });
  // MSBuild repeats every diagnostic in its closing summary.
  return diagnosticDigest('msbuild', diagnostics);
}
