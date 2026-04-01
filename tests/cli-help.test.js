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

test('CLI accepts --h as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /SiftKit CLI/u);
});

test('CLI accepts -help as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['-help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Usage:/u);
});

test('repo-search help works without server startup', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /repo-search/u);
});

test('summary requires stdin, --text, or --file', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['summary', '--question', 'hello'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /stdin, --text or --file required/u);
});
