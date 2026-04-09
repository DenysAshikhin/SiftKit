import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMetricGraphStorageKey,
  readHiddenSeriesState,
  sanitizeHiddenSeriesState,
  writeHiddenSeriesState,
  type KeyValueStore,
} from '../dashboard/src/metric-graph-persistence.ts';

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('getMetricGraphStorageKey uses the graph id in the storage key', () => {
  assert.equal(
    getMetricGraphStorageKey('daily-usage'),
    'siftkit.dashboard.metric-graph.daily-usage.hidden-series',
  );
});

test('readHiddenSeriesState restores known hidden series from storage', () => {
  const store = new MemoryStore();
  store.setItem(
    getMetricGraphStorageKey('daily-usage'),
    JSON.stringify({ input: true, output: true }),
  );

  assert.deepEqual(
    readHiddenSeriesState(store, 'daily-usage', ['runs', 'input', 'output']),
    { input: true, output: true },
  );
});

test('readHiddenSeriesState returns empty state for malformed JSON', () => {
  const store = new MemoryStore();
  store.setItem(getMetricGraphStorageKey('daily-usage'), '{bad-json');

  assert.deepEqual(
    readHiddenSeriesState(store, 'daily-usage', ['runs', 'input', 'output']),
    {},
  );
});

test('readHiddenSeriesState returns empty state for non-object JSON', () => {
  const store = new MemoryStore();
  store.setItem(getMetricGraphStorageKey('daily-usage'), JSON.stringify(['input']));

  assert.deepEqual(
    readHiddenSeriesState(store, 'daily-usage', ['runs', 'input', 'output']),
    {},
  );
});

test('sanitizeHiddenSeriesState drops unknown and non-hidden entries', () => {
  assert.deepEqual(
    sanitizeHiddenSeriesState(
      { input: true, output: false, unknown: true, duration: 'yes' },
      ['runs', 'input', 'output'],
    ),
    { input: true },
  );
});

test('writeHiddenSeriesState removes storage when nothing is hidden', () => {
  const store = new MemoryStore();
  const key = getMetricGraphStorageKey('daily-usage');
  store.setItem(key, JSON.stringify({ input: true }));

  writeHiddenSeriesState(store, 'daily-usage', {}, ['runs', 'input', 'output']);

  assert.equal(store.getItem(key), null);
});

test('writeHiddenSeriesState persists only known hidden series', () => {
  const store = new MemoryStore();
  const key = getMetricGraphStorageKey('daily-usage');

  writeHiddenSeriesState(
    store,
    'daily-usage',
    { input: true, output: false, unknown: true },
    ['runs', 'input', 'output'],
  );

  assert.equal(store.getItem(key), JSON.stringify({ input: true }));
});
