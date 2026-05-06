import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type ReactType from 'react';
import type { renderToStaticMarkup as RenderToStaticMarkupType } from 'react-dom/server';

import { App } from '../dashboard/src/App';

const dashboardRequire = createRequire(path.resolve('dashboard/package.json'));
const React = dashboardRequire('react') as typeof ReactType;
const { renderToStaticMarkup } = dashboardRequire('react-dom/server') as {
  renderToStaticMarkup: typeof RenderToStaticMarkupType;
};
(globalThis as typeof globalThis & { React: typeof ReactType }).React = React;

function withDashboardWindow<T>(callback: () => T): T {
  const globalWithWindow = globalThis as typeof globalThis & { window: Window & typeof globalThis };
  const previousWindow = globalWithWindow.window;
  globalWithWindow.window = {
    location: { pathname: '/', search: '' },
    history: { replaceState: () => {} },
  } as Window & typeof globalThis;
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

test('dashboard data refresh effects are not scheduled on intervals', () => {
  const appSource = fs.readFileSync(path.resolve('dashboard/src/App.tsx'), 'utf8');

  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshRuns\(\); \},/u);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshMetrics\(\); \},/u);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{ void refreshSessions\(\); \},/u);
});
