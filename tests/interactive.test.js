const test = require('node:test');
const assert = require('node:assert/strict');

const { runInteractiveCapture } = require('../dist/interactive.js');
const { withTestEnvAndServer } = require('./_test-helpers.js');

test('runInteractiveCapture runs a simple command and produces output', async () => {
  await withTestEnvAndServer(async () => {
    const result = await runInteractiveCapture({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("hello from interactive capture test")'],
      Question: 'What was the output?',
    });
    assert.equal(typeof result.ExitCode, 'number');
    assert.equal(typeof result.TranscriptPath, 'string');
    assert.equal(typeof result.WasSummarized, 'boolean');
    assert.equal(typeof result.OutputText, 'string');
    assert.ok(result.OutputText.length > 0);
  });
});

test('runInteractiveCapture handles nonexistent command', async () => {
  await withTestEnvAndServer(async () => {
    try {
      const result = await runInteractiveCapture({
        Command: 'nonexistent_command_xyz_test_12345',
        Question: 'What happened?',
      });
      // Either throws or returns with exit code 1
      assert.equal(typeof result.ExitCode, 'number');
    } catch (error) {
      assert.match(error.message, /Unable to resolve|ENOENT|not found/u);
    }
  });
});

test('runInteractiveCapture with JSON format', async () => {
  await withTestEnvAndServer(async () => {
    const result = await runInteractiveCapture({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("test output for json format")'],
      Question: 'Extract the output',
      Format: 'json',
    });
    assert.equal(typeof result.OutputText, 'string');
    assert.ok(result.OutputText.length > 0);
  });
});

test('runInteractiveCapture with empty output handles gracefully', async () => {
  await withTestEnvAndServer(async () => {
    const result = await runInteractiveCapture({
      Command: 'node',
      ArgumentList: ['-e', ''],
      Question: 'What happened?',
    });
    assert.equal(typeof result.ExitCode, 'number');
    assert.equal(typeof result.TranscriptPath, 'string');
  });
});

test('runInteractiveCapture with custom policy profile', async () => {
  await withTestEnvAndServer(async () => {
    const result = await runInteractiveCapture({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("pass fail test")'],
      Question: 'Did the test pass or fail?',
      PolicyProfile: 'pass-fail',
    });
    assert.equal(typeof result.PolicyDecision, 'string');
  });
});
