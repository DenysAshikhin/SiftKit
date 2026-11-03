import type { DigestFailure, ToolDigest } from './types.ts';

const PACKAGE_LINE = /^(ok|FAIL)\s+\S+\s+(?:\(cached\)|[\d.]+s|\[(?:build|setup) failed\])/u;
const RUN_LINE = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)$/u;
const RESULT_LINE = /^\s*--- (FAIL|PASS|SKIP): (\S+) \(/u;
const MESSAGE_LINE = /^\s+(\S+\.go:\d+): (.*)$/u;
const BUILD_HEADING = /^# \S+/u;
const COMPILE_ERROR = /^(\S+\.go:\d+:\d+): (.*)$/u;

/**
 * A test's `file:line: message` lines belong to the latest `=== RUN` or `--- FAIL` name: `-v` prints them
 * before the result line, the default output after it. A parent fails with its subtests, so only leaves are listed.
 */
export function parseGoTest(lines: readonly string[]): ToolDigest | null {
  let ok = 0;
  let failedPackages = 0;
  let current: string | null = null;
  let inBuild = false;
  const failedTests: string[] = [];
  const messages = new Map<string, { location: string; text: string }[]>();
  const buildErrors: DigestFailure[] = [];
  for (const line of lines) {
    const pkg = PACKAGE_LINE.exec(line);
    if (pkg !== null) {
      if (pkg[1] === 'ok') ok += 1;
      else failedPackages += 1;
    }
    const compile: RegExpExecArray | null = inBuild ? COMPILE_ERROR.exec(line) : null;
    if (compile !== null) buildErrors.push({ name: compile[2], location: compile[1], message: [] });
    inBuild = BUILD_HEADING.test(line) || compile !== null;
    const run = RUN_LINE.exec(line);
    const result = RESULT_LINE.exec(line);
    current = run?.[1] ?? result?.[2] ?? current;
    if (result?.[1] === 'FAIL' && !failedTests.includes(result[2])) failedTests.push(result[2]);
    const message = MESSAGE_LINE.exec(line);
    if (message === null || current === null) continue;
    const own = messages.get(current) ?? [];
    own.push({ location: message[1], text: message[2] });
    messages.set(current, own);
  }
  if (ok + failedPackages === 0 && failedTests.length === 0) return null;
  const leaves = failedTests.filter((name) => !failedTests.some((other) => other.startsWith(`${name}/`)));
  const failures = [...leaves.map((name) => {
    const own = messages.get(name) ?? [];
    return { name, location: own[0]?.location ?? null, message: own.map((entry) => entry.text) };
  }), ...buildErrors];
  const counts = [{ label: 'packages', value: ok + failedPackages }, { label: 'ok', value: ok }, { label: 'failed', value: failedPackages }];
  return { tool: 'go test', counts, failed: failedPackages > 0 || failures.length > 0, failures };
}
