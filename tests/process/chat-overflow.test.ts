import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { OrchestratorRunStateSchema } from '@siftkit/contracts';
import { HeadlessChrome, bundleBrowserPage, bundleResponse } from '../helpers/browser-page.js';
import { HOSTILE_PATH, OVERFLOW_PRESENT, OverflowReportSchema, UNBROKEN } from '../../dashboard/tests/chat-overflow-content.js';

const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: `npm test -- ${UNBROKEN}`, cwd: '.', expectedExitCode: 0 } as const;
const TASK = { id: 'task', title: UNBROKEN, dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: [HOSTILE_PATH],
  steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Done.'], temporaryPaths: [] };
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const RUN = OrchestratorRunStateSchema.parse({
  runId: RUN_ID, request: { submissionId: RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: UNBROKEN, planPath: null },
  revision: 3, phase: 'approval_required', planPath: `C:/repo/${HOSTILE_PATH}plan.md`, planHash: 'h',
  plan: { goal: UNBROKEN, constraints: [], tasks: [TASK], finalVerification: [CHECK] },
  tasks: [{ taskId: TASK.id, status: 'correcting_drift', reviewedDigests: ['d'], driftReview: { taskId: TASK.id, changeDigest: 'd', scopePaths: [],
    resolutions: [], status: 'actionable', findings: [{ id: 'f1', title: UNBROKEN, purpose: 'p', directive: 'd', impact: 'i', fix: 'f',
      evidence: [{ path: HOSTILE_PATH, line: 1, snippet: UNBROKEN }], affectedPaths: [HOSTILE_PATH], verification: [CHECK] }] } }],
  attempts: [{ taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: CHILD_ID, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK }, status: 'settled',
    result: { taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: CHILD_ID, workerStatus: 'completed', workerOutput: UNBROKEN,
      passed: false, checks: [{ check: CHECK, executed: true, exitCode: 1, timedOut: false, output: UNBROKEN }],
      findings: [], changedPaths: [HOSTILE_PATH], scopeViolations: [], changeDigest: 'd' } }],
  phaseRunIds: [], failure: null, createdAtUtc: AT, updatedAtUtc: AT,
  approval: { kind: 'child', approvalId: '00000000-0000-4000-8000-000000000003', childRunId: CHILD_ID, taskId: TASK.id, toolName: 'run',
    command: `rm -rf ${HOSTILE_PATH}`, reviewPayload: UNBROKEN },
});

/** Serves the page at /page/ and the one orchestrator run it lists; its event stream closes at once on the same state. */
function serve(bundles: ReadonlyMap<string, Map<string, string>>): Promise<http.Server> {
  const routes = new Map([
    ['/orchestrator/runs', { contentType: 'application/json', body: JSON.stringify({ runs: [RUN] }) }],
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
