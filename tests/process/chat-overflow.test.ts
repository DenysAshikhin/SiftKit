import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { OrchestratorRunStateSchema } from '@siftkit/contracts';
import { parseJsonText } from '../../src/lib/json.js';
import { PAGE_HTML, bundleBrowserPage, findChrome } from '../helpers/browser-page.js';
import { HOSTILE_PATH, OVERFLOW_PRESENT, OverflowResultSchema, UNBROKEN } from '../../dashboard/tests/chat-overflow-content.js';

const execFileAsync = promisify(execFile);
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

/** Serves the page and the one orchestrator run it lists; its event stream closes at once on the same state. */
function serve(files: Map<string, string>): Promise<http.Server> {
  const routes = new Map<string, [string, string]>([
    ['/', ['text/html', PAGE_HTML]],
    ['/page.js', ['text/javascript', files.get('page.js') ?? '']],
    ['/page.css', ['text/css', files.get('page.css') ?? '']],
    ['/orchestrator/runs', ['application/json', JSON.stringify({ runs: [RUN] })]],
    ['/orchestrator/events', ['text/event-stream', `event: result\ndata: ${JSON.stringify(RUN)}\n\n`]],
  ]);
  const server = http.createServer((request, response) => {
    const route = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname);
    response.writeHead(route ? 200 : 404, { 'Content-Type': route?.[0] ?? 'text/plain' }).end(route?.[1] ?? 'not found');
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

test('no chat content scrolls the transcript sideways or escapes its bubble in a real browser', { timeout: 120_000 }, async () => {
  const server = await serve(await bundleBrowserPage(path.join('dashboard', 'tests', 'chat-overflow-page.tsx')));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') assert.fail('The page server has no TCP port.');
    const { stdout } = await execFileAsync(findChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1000,1400', '--virtual-time-budget=10000', '--dump-dom', `http://127.0.0.1:${address.port}/`], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
    const output = /<script type="application\/json" id="overflow-result">([\s\S]*?)<\/script>/u.exec(stdout)?.[1];
    if (output === undefined) assert.fail('The page never reported a measurement.');
    const result = parseJsonText(output, OverflowResultSchema);
    if ('error' in result) assert.fail(result.error);
    assert.deepEqual(result.report.present, OVERFLOW_PRESENT);
    assert.deepEqual(result.report.scenarios, ['question', 'approval', 'orchestrator'].map((name) => ({ name, sideways: [0, 0], escapes: [] })));
  } finally {
    server.close();
  }
});
