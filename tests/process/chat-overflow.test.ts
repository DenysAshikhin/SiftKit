import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { OrchestratorRunStateSchema } from '@siftkit/contracts';
import { HeadlessChrome, bundleBrowserPage, bundleResponse } from '../helpers/browser-page.ts';
import { HOSTILE_PATH, OVERFLOW_PRESENT, OverflowReportSchema, UNBROKEN } from '../../dashboard/tests/chat-overflow-content.ts';

const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: `npm test -- ${UNBROKEN}`, cwd: '.', expectedExitCode: 0 } as const;
const TASK = { id: 'task', title: UNBROKEN, dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: [HOSTILE_PATH],
  steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Done.'], temporaryPaths: [] };
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const RUN = OrchestratorRunStateSchema.parse({
  runId: RUN_ID, request: { submissionId: RUN_ID, sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: UNBROKEN, planPath: null },
  revision: 3, phase: 'approval_required', planPath: `C:/repo/${HOSTILE_PATH}plan.md`, planHash: 'h',
  plan: { goal: UNBROKEN, constraints: [], tasks: [TASK], finalVerification: [CHECK] },
  tasks: [{ taskId: TASK.id, status: 'reviewing', review: { attempt: 1, purpose: 'implementation', verdict: 'fail',
    criteria: [{ index: 0, met: false, evidence: [{ path: HOSTILE_PATH, line: 1, snippet: UNBROKEN }] }],
    findings: [{ path: HOSTILE_PATH, line: 1, issue: UNBROKEN }] } }],
  attempts: [{ taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: CHILD_ID, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK, instruction: UNBROKEN }, status: 'settled',
    result: { taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: CHILD_ID, workerStatus: 'completed', workerOutput: UNBROKEN,
      report: null, outcome: 'checks_failed', submissions: 3, passed: false, checks: [{ check: CHECK, executed: true, exitCode: 1, timedOut: false, output: UNBROKEN }],
      findings: [], changedPaths: [HOSTILE_PATH], changeDigest: 'd' } }],
  parentRunIds: [], failure: null, createdAtUtc: AT, updatedAtUtc: AT,
  approval: { kind: 'child', approvalId: '00000000-0000-4000-8000-000000000003', childRunId: CHILD_ID, taskId: TASK.id, toolName: 'run',
    command: `rm -rf ${HOSTILE_PATH}`, reviewPayload: UNBROKEN },
});

/** Serves the page at /page/ and the one orchestrator run its session names; its event stream closes at once on the same state. */
function serve(bundles: ReadonlyMap<string, Map<string, string>>): Promise<http.Server> {
  const routes = new Map([
    ['/orchestrator/status', { contentType: 'application/json', body: JSON.stringify(RUN) }],
    ['/orchestrator/events', { contentType: 'text/event-stream', body: `event: result
data: ${JSON.stringify(RUN)}

` }],
  ]);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const route = routes.get(pathname) ?? bundleResponse(bundles, pathname);
    if (route === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': route.contentType }).end(route.body);
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

test('no chat content scrolls sideways, escapes its box, or loses its alignment in a real browser', { timeout: 120_000 }, async () => {
  const server = await serve(new Map([['page', await bundleBrowserPage(path.join('dashboard', 'tests', 'chat-overflow-page.tsx'))]]));
  const chrome = await HeadlessChrome.launch();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') assert.fail('The page server has no TCP port.');
    const page = await chrome.open(`http://127.0.0.1:${String(address.port)}/page/`, 'runOverflow');
    const report = await page.evaluate('window.runOverflow()', true, OverflowReportSchema);
    assert.deepEqual(report.present, OVERFLOW_PRESENT);
    assert.deepEqual(report.scenarios, ['question', 'approval', 'orchestrator']
      .map((name) => ({ name, sideways: [0, 0], escapes: [], misaligned: [], estimateErrors: [] })));
  } finally {
    await chrome.close();
    server.close();
  }
});
