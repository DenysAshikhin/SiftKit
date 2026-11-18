import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIgnorePolicy } from '../src/repo-search/command-safety.ts';
import { buildReadExecution, executeRepoTool, isFailedReadPlan, planRead } from '../src/repo-search/engine/repo-tools.ts';
import { findCitationProblem } from '../src/orchestrator/verification.ts';
import { formatLineCount } from '../src/lib/source-lines.ts';
import { LINE_COUNT_FIXTURES, writeLineCountFixtures } from './helpers/line-count-fixtures.ts';
import { makeContext, makeRepo, nativeCall } from './helpers/repo-tools-fixtures.ts';

function countIn(output: string, name: string): number {
  const line = output.split('\n').find((entry) => entry.startsWith(`${name} (`));
  const match = line === undefined ? null : /\((\d+) lines?\)$/u.exec(line);
  if (match === null) throw new Error(`no line count for ${name} in:\n${output}`);
  return Number(match[1]);
}

// grep's agreement needs a real rg, so it lives in tests/process/repo-tools.test.ts.
test('find, ls, read, and the citation check agree on every file\'s line count', async () => {
  const root = makeRepo();
  const directory = writeLineCountFixtures(root);
  const context = makeContext(root);
  const found = await executeRepoTool(nativeCall('find', { pattern: '*', path: directory }), context);
  const listed = await executeRepoTool(nativeCall('ls', { path: directory }), context);
  assert.ok(found.ok, found.ok ? '' : found.reason);
  assert.ok(listed.ok, listed.ok ? '' : listed.reason);
  for (const fixture of LINE_COUNT_FIXTURES) {
    const relative = `${directory}/${fixture.name}`;
    assert.equal(countIn(found.output, fixture.name), fixture.lines, `find ${fixture.name}`);
    assert.equal(countIn(listed.output, fixture.name), fixture.lines, `ls ${fixture.name}`);
    const plan = planRead({ path: relative, offset: 1 }, root, buildIgnorePolicy(root));
    assert.ok(!isFailedReadPlan(plan));
    const read = buildReadExecution('read', plan);
    assert.ok(read.ok);
    const readEnding = fixture.lines === 0 ? 'is empty (0 lines).' : `(end of file: ${formatLineCount(fixture.lines)})`;
    assert.ok(read.output.endsWith(readEnding), `read ${fixture.name}: ${read.output}`);
    if (fixture.lines > 0) assert.equal(findCitationProblem(root, { path: relative, line: fixture.lines }), null, `citation ${fixture.name}`);
    assert.equal(findCitationProblem(root, { path: relative, line: fixture.lines + 1 }), `${relative}:${fixture.lines + 1} is past the end of the file`);
  }
});
