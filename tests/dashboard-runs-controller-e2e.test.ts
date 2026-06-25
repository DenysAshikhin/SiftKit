import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { useToasts } from '../dashboard/src/hooks/useToasts.js';
import { useDashboardRefresh } from '../dashboard/src/hooks/useDashboardRefresh.js';
import { useRunsController } from '../dashboard/src/hooks/useRunsController.js';

// Real DOM client render (jsdom + react-dom/client + React.act) so useEffect actually
// runs — SSR (renderToStaticMarkup) never fires effects, so the runs controller's
// fetch-on-mount, refreshToken re-fetch, and delete→refresh flows were unverified.
// require() returns are intentionally implicit-any (no `as` casts) to satisfy the gate.
const dashboardRequire = createRequire(path.resolve('dashboard/package.json'));
const rootRequire = createRequire(path.resolve('package.json'));
const React = dashboardRequire('react');
const { createRoot } = dashboardRequire('react-dom/client');
const { JSDOM } = rootRequire('jsdom');

const RUN_ID = 'run-1';
function makeRun() {
  return {
    id: RUN_ID, kind: 'summary', status: 'completed',
    startedAtUtc: null, finishedAtUtc: null, title: 'Probe Run',
    model: null, backend: null, inputTokens: null, outputTokens: null, thinkingTokens: null,
    toolTokens: null, promptCacheTokens: null, promptEvalTokens: null,
    promptEvalDurationMs: null, generationDurationMs: null,
    speculativeAcceptedTokens: null, speculativeGeneratedTokens: null,
    durationMs: null, providerDurationMs: null, wallDurationMs: null, rawPaths: {},
  };
}

function jsonResponse(payload: object) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function Probe() {
  const { toasts, enqueueToast } = useToasts();
  const refresh = useDashboardRefresh();
  const runs = useRunsController({
    enqueueToast,
    refreshToken: refresh.refreshToken,
    runsCacheResetRef: refresh.runsCacheResetRef,
    requestDashboardDataRefresh: refresh.requestDashboardDataRefresh,
  });
  const allRuns = Object.values(runs.tabProps.groupedRuns).flat();
  return React.createElement(
    'div',
    null,
    React.createElement('ul', { 'data-testid': 'runs' }, allRuns.map((run) => (
      React.createElement('li', { key: run.id }, run.title)
    ))),
    React.createElement('button', { 'data-testid': 'refresh', onClick: refresh.requestDashboardDataRefresh }, 'refresh'),
    React.createElement('button', { 'data-testid': 'delete', onClick: () => { void runs.runDelete.confirm(); } }, 'delete'),
    React.createElement('div', { 'data-testid': 'toasts' }, toasts.map((toast) => toast.text).join('|')),
  );
}

test('runs controller fetches on mount, re-fetches on refresh, and deletes with refresh propagation', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  let runsFetchCount = 0;
  let deleteFetchCount = 0;
  let deleted = false;
  async function fetchStub(input: string) {
    const url = String(input);
    if (url.includes('/dashboard/admin/run-logs/preview')) {
      return jsonResponse({ ok: true, matchCount: 1 });
    }
    if (url.includes('/dashboard/admin/run-logs')) {
      deleteFetchCount += 1;
      deleted = true;
      return jsonResponse({ ok: true, deletedCount: 1, deletedRunIds: [RUN_ID] });
    }
    if (url.includes('/dashboard/runs')) {
      runsFetchCount += 1;
      return jsonResponse({ runs: deleted ? [] : [makeRun()], total: deleted ? 0 : 1 });
    }
    return jsonResponse({});
  }

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchStub,
  });

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  // Mount: the runs effect runs, fetches /dashboard/runs, and renders the run.
  await React.act(async () => { root.render(React.createElement(Probe)); });
  assert.equal(runsFetchCount, 1);
  assert.match(container.textContent, /Probe Run/u);

  // Refresh: requestDashboardDataRefresh bumps refreshToken → effect re-fetches.
  const refreshButton = container.querySelector('[data-testid="refresh"]');
  assert.ok(refreshButton);
  await React.act(async () => {
    refreshButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(runsFetchCount, 2);

  // Delete: confirm hits the delete endpoint, removes the run, and propagates a refresh.
  const deleteButton = container.querySelector('[data-testid="delete"]');
  assert.ok(deleteButton);
  await React.act(async () => {
    deleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(deleteFetchCount, 1);
  assert.equal(runsFetchCount, 3);
  assert.doesNotMatch(container.textContent, /Probe Run/u);
  assert.match(container.querySelector('[data-testid="toasts"]').textContent, /.+/u);

  await React.act(async () => { root.unmount(); });
});
