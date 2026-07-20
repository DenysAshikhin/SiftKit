import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricChart } from '../src/components/MetricChart';
import { getMetricGraphStorageKey } from '../src/metric-graph-persistence';

const SERIES = [
  { key: 'runs', title: 'Runs', unit: '', color: '#17997e', points: [{ label: 'd1', value: 3 }, { label: 'd2', value: 5 }] },
  { key: 'failed', title: 'Failed', unit: '', color: '#d95f5f', points: [{ label: 'd1', value: 1 }, { label: 'd2', value: 0 }] },
];

test('metric chart renders title, subtitle, and a legend chip per series', () => {
  const markup = renderToStaticMarkup(
    <MetricChart storageId="daily-runs" title="Daily Runs" subtitle="last 14 days" series={SERIES} />,
  );
  assert.match(markup, /Daily Runs/);
  assert.match(markup, /last 14 days/);
  assert.match(markup, /Runs/);
  assert.match(markup, /Failed/);
});

test('legend toggle uses the shared graph storage key format', () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
  const markup = renderToStaticMarkup(
    <MetricChart storageId="daily-runs" title="Daily Runs" series={SERIES} storageOverride={store} />,
  );
  assert.match(markup, /graph-legend-chip/);
  assert.equal(getMetricGraphStorageKey('daily-runs'), 'siftkit.dashboard.metric-graph.daily-runs.hidden-series');
});
