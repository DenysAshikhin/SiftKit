import { parseCargoTest } from './cargo-test.ts';
import { parseDotnetTest } from './dotnet-test.ts';
import { parseEslint } from './eslint.ts';
import { parseGoTest } from './go-test.ts';
import { parseJest } from './jest.ts';
import { stripTerminalCodes } from './lines.ts';
import { parseMsbuild } from './msbuild.ts';
import { parseMypy } from './mypy.ts';
import { parseNodeTest } from './node-test.ts';
import { parsePyright } from './pyright.ts';
import { parsePytest } from './pytest.ts';
import { parseTsc } from './tsc.ts';
import type { DigestFailure, ToolDigest } from './types.ts';
import { parseVitest } from './vitest.ts';

export const DIGEST_HEADING = 'Digest of the whole output:';
const MESSAGE_LINE_CAP = 12;

/** One digest per tool whose output markers appear in `text`, in a fixed order; none for unrecognised output. */
export function digestToolOutput(text: string): ToolDigest[] {
  const lines = stripTerminalCodes(text).split(/\r?\n/u);
  return [
    parseNodeTest(lines), parseVitest(lines), parseJest(lines), parsePytest(lines), parseDotnetTest(lines), parseGoTest(lines),
    parseCargoTest(lines), parseTsc(lines), parseMypy(lines), parsePyright(lines), parseMsbuild(lines), parseEslint(lines),
  ].flatMap((digest) => digest ?? []);
}

function headline(digest: ToolDigest): string {
  const counts = digest.counts.map((count) => `${count.value} ${count.label}`).join(', ');
  return `${digest.tool}: ${digest.failed ? 'FAILED' : 'passed'}${counts.length > 0 ? ` (${counts})` : ''}`;
}

function failureLine(failure: DigestFailure): string {
  return failure.location === null ? `✖ ${failure.name}` : `✖ ${failure.name} — ${failure.location}`;
}

function detailLines(failure: DigestFailure): string[] {
  if (failure.message.length === 0) return [];
  const hidden = failure.message.length - MESSAGE_LINE_CAP;
  return [
    `✖ ${failure.name}`,
    ...failure.message.slice(0, MESSAGE_LINE_CAP).map((line) => `  ${line}`),
    ...(hidden > 0 ? [`  … ${hidden} more lines`] : []),
  ];
}

/** Every tool's verdict and failure list come before any details, so cutting the text from its end keeps them. */
export function renderDigests(digests: readonly ToolDigest[]): string | null {
  if (digests.length === 0) return null;
  const details = digests.flatMap((digest) => digest.failures.flatMap(detailLines));
  return [
    DIGEST_HEADING,
    ...digests.flatMap((digest) => [headline(digest), ...digest.failures.map(failureLine)]),
    ...(details.length > 0 ? ['Details:', ...details] : []),
  ].join('\n');
}
