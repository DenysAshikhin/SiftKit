const test = require('node:test');
const assert = require('node:assert/strict');

const { terminateProcessTree } = require('../siftKitStatus/index.js');

test('terminateProcessTree rejects invalid pid values', () => {
  assert.equal(terminateProcessTree(0), false);
  assert.equal(terminateProcessTree(-1), false);
  assert.equal(terminateProcessTree('abc'), false);
});

test('terminateProcessTree uses taskkill on Windows and returns true on success', () => {
  const calls = [];
  const result = terminateProcessTree(1234, {
    processObject: {
      platform: 'win32',
      kill() {
        throw new Error('kill should not be called when taskkill succeeds');
      },
    },
    spawnSyncImpl(file, args) {
      calls.push({ file, args });
      return { status: 0 };
    },
  });

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '1234', '/T', '/F']);
});

test('terminateProcessTree falls back to process.kill when taskkill fails', () => {
  const killCalls = [];
  const result = terminateProcessTree(2222, {
    processObject: {
      platform: 'win32',
      kill(pid, signal) {
        killCalls.push({ pid, signal });
      },
    },
    spawnSyncImpl() {
      return { status: 1 };
    },
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 2222, signal: 'SIGTERM' }]);
});

test('terminateProcessTree uses process.kill on non-Windows platforms', () => {
  const killCalls = [];
  const result = terminateProcessTree(3333, {
    processObject: {
      platform: 'linux',
      kill(pid, signal) {
        killCalls.push({ pid, signal });
      },
    },
    spawnSyncImpl() {
      throw new Error('taskkill should not run on non-Windows');
    },
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 3333, signal: 'SIGTERM' }]);
});
