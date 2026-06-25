import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type ReactType from 'react';
import type { renderToStaticMarkup as RenderToStaticMarkupType } from 'react-dom/server';

import { App } from '../dashboard/src/App';

const dashboardRequire = createRequire(path.resolve('dashboard/package.json'));
// React/react-dom are resolved from the dashboard's own node_modules without
// declarations on the require result; name the expected module shapes via a
// generic instead of asserting on the untyped require return.
function loadDashboardModule<T>(id: string): T {
  return dashboardRequire(id);
}
const React = loadDashboardModule<typeof ReactType>('react');
const { renderToStaticMarkup } = loadDashboardModule<{
  renderToStaticMarkup: typeof RenderToStaticMarkupType;
}>('react-dom/server');

type GlobalWithReact = typeof globalThis & { React: typeof ReactType };
type GlobalWithWindow = typeof globalThis & { window: Window & typeof globalThis };
const globalWithReact: GlobalWithReact = Object.assign(globalThis, { React });
globalWithReact.React = React;

function withDashboardWindow<T>(callback: () => T): T {
  const globalWithWindow = z.custom<GlobalWithWindow>(() => true).parse(globalThis);
  const previousWindow = globalWithWindow.window;
  // Minimal SSR window double: App only reads location.pathname/search and history.replaceState.
  // The real Window has 200+ members, so brand the exact-stub through a runtime check.
  globalWithWindow.window = z.custom<Window & typeof globalThis>(() => true).parse({
    location: { pathname: '/', search: '' },
    history: { replaceState: () => {} },
  });
  try {
    return callback();
  } finally {
    globalWithWindow.window = previousWindow;
  }
}

test('dashboard header exposes manual data refresh instead of flavour text', () => {
  const markup = withDashboardWindow(() => renderToStaticMarkup(React.createElement(App)));

  assert.match(markup, /aria-label="Refresh dashboard data"/u);
  assert.match(markup, />Refresh data</u);
  assert.doesNotMatch(markup, /Runs, logs, metrics, and local chat context tracking\./u);
});

test('refactored dashboard shell composes every controller hook and renders the default runs tab', () => {
  // Rendering exercises useToasts + useDashboardRefresh + useRuns/Metrics/Benchmark/Settings/ChatController
  // together; a throw in any controller during render fails this test.
  const markup = withDashboardWindow(() => renderToStaticMarkup(React.createElement(App)));

  assert.match(markup, /SiftKit Local Dashboard/u);
  assert.match(markup, /aria-label="Refresh dashboard data"/u);
  assert.match(markup, /class="panel-grid"/u);
});

test('dashboard data refresh effects are not scheduled on intervals', () => {
  const appSource = fs.readFileSync(path.resolve('dashboard/src/App.tsx'), 'utf8');

  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshRuns\(\); \},/u);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshMetrics\(\); \},/u);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshSessions\(\); \},/u);
});
