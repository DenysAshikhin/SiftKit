import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStatusServerBindHost,
  getStatusServerConnectHost,
} from '../dist/lib/status-host.js';

function withStatusHost(value: string | undefined, run: () => void): void {
  const previous = process.env.SIFTKIT_STATUS_HOST;
  if (value === undefined) {
    delete process.env.SIFTKIT_STATUS_HOST;
  } else {
    process.env.SIFTKIT_STATUS_HOST = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.SIFTKIT_STATUS_HOST;
    } else {
      process.env.SIFTKIT_STATUS_HOST = previous;
    }
  }
}

test('bind host defaults to 0.0.0.0 so the status API is network-reachable', () => {
  withStatusHost(undefined, () => {
    assert.equal(getStatusServerBindHost(), '0.0.0.0');
  });
});

test('connect host collapses the default/wildcard bind to loopback', () => {
  withStatusHost(undefined, () => {
    assert.equal(getStatusServerConnectHost(), '127.0.0.1');
  });
  for (const wildcard of ['0.0.0.0', '::', '[::]', '*']) {
    withStatusHost(wildcard, () => {
      assert.equal(getStatusServerConnectHost(), '127.0.0.1');
    });
  }
});

test('an explicit concrete host is honored for both bind and connect', () => {
  withStatusHost('10.0.0.9', () => {
    assert.equal(getStatusServerBindHost(), '10.0.0.9');
    assert.equal(getStatusServerConnectHost(), '10.0.0.9');
  });
});

test('whitespace-only SIFTKIT_STATUS_HOST falls back to defaults', () => {
  withStatusHost('   ', () => {
    assert.equal(getStatusServerBindHost(), '0.0.0.0');
    assert.equal(getStatusServerConnectHost(), '127.0.0.1');
  });
});
