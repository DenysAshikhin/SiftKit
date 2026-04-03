const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const { runCli } = require('../dist/cli.js');

function makeCaptureStream() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read() {
      return text;
    },
  };
}

test('blocked public commands are not accessible', async () => {
  const blocked = ['run', 'install', 'test', 'eval', 'config-get', 'config-set'];
  for (const command of blocked) {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [command],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /not exposed in this CLI build/u);
  }
});

