import test from 'node:test';
import assert from 'node:assert/strict';

import { ServerLogger, shortenRequestId } from '../src/status-server/server-logger.js';

function collect(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text: string) => { lines.push(text); } };
}

test('event lines are compact and uncoloured when colour is disabled', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'normal', colour: false, write: sink.write });

  logger.event({
    scope: 'rs',
    id: 'ddda7acf-fe04-45b8-9005-2180c3327878',
    event: 'preflight',
    fields: 't4/45  prompt=32,944tok/102.9kc',
    date: new Date(2026, 6, 21, 20, 42, 37),
  });

  assert.equal(sink.lines.length, 1);
  assert.equal(
    sink.lines[0],
    '20:42:37  rs ddda7acf  preflight  t4/45  prompt=32,944tok/102.9kc\n',
  );
});

test('debug events are suppressed at normal level and emitted at debug level', () => {
  const quiet = collect();
  new ServerLogger({ level: 'normal', colour: false, write: quiet.write })
    .debug({ scope: 'rs', id: 'abcdef12', event: 'preflight_start', fields: '' });
  assert.equal(quiet.lines.length, 0);

  const loud = collect();
  new ServerLogger({ level: 'debug', colour: false, write: loud.write })
    .debug({ scope: 'rs', id: 'abcdef12', event: 'preflight_start', fields: '' });
  assert.equal(loud.lines.length, 1);
});

test('normal and dim events are suppressed at quiet level', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'quiet', colour: false, write: sink.write });

  logger.event({ scope: 'rs', id: 'abcdef12', event: 'preflight', fields: '' });
  logger.dim({ scope: 'st', id: 'abcdef12', event: 'drain_wait', fields: '' });

  assert.equal(sink.lines.length, 0);
});

test('error lines survive quiet level and carry the red SGR when colour is enabled', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'quiet', colour: true, write: sink.write });

  logger.error({ scope: 'st', id: 'abcdef12', event: 'spawn_failed', fields: 'exit=1' });

  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0].includes('\x1b[31m'), 'error lines must be red');
});

test('ok lines survive quiet level and carry the green SGR when colour is enabled', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'quiet', colour: true, write: sink.write });

  logger.ok({ scope: 'llama', id: '', event: 'ready', fields: 'base_url=http://127.0.0.1:8080' });

  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0].includes('\x1b[32m'), 'terminal success lines must be green');
  assert.ok(sink.lines[0].includes('--------'), 'an absent id renders as the placeholder');
});

test('dim events emit at normal level with the dim SGR', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'normal', colour: true, write: sink.write });

  logger.dim({ scope: 'st', id: 'abcdef12', event: 'drain_wait', fields: 'q=4' });

  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0].includes('\x1b[2m'), 'queue lines must be dim');
});

test('continuation lines are indented to the field column and gated at quiet level', () => {
  const normal = collect();
  new ServerLogger({ level: 'normal', colour: false, write: normal.write })
    .continuation('read  tests/runtime-db-schema-v29.test.ts  1+120');
  assert.equal(normal.lines.length, 1);
  assert.equal(
    normal.lines[0],
    `${' '.repeat(35)}read  tests/runtime-db-schema-v29.test.ts  1+120\n`,
  );

  const quiet = collect();
  new ServerLogger({ level: 'quiet', colour: false, write: quiet.write }).continuation('read  x');
  assert.equal(quiet.lines.length, 0);
});

test('fieldless events omit the trailing separator', () => {
  const sink = collect();
  new ServerLogger({ level: 'normal', colour: false, write: sink.write }).event({
    scope: 'st',
    id: 'abcdef12',
    event: 'shutdown',
    fields: '',
    date: new Date(2026, 6, 21, 9, 5, 3),
  });

  assert.equal(sink.lines[0], '09:05:03  st abcdef12  shutdown\n');
});

test('request ids are shortened to eight characters', () => {
  assert.equal(shortenRequestId('ddda7acf-fe04-45b8-9005-2180c3327878'), 'ddda7acf');
  assert.equal(shortenRequestId('  ddda7acf-fe04  '), 'ddda7acf');
  assert.equal(shortenRequestId(''), '--------');
  assert.equal(shortenRequestId('   '), '--------');
});
