import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProgressRenderer, SilentProgressRenderer } from '../src/cli/progress-renderer.js';
import { makeCaptureStream } from './_test-helpers.js';

test('renders known progress kinds as single stderr lines', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({ kind: 'lock_wait', queueLength: 1, elapsedMs: 4_200 });
  renderer.render({
    kind: 'llm_start', turn: 3, maxTurns: 24, promptTokenCount: 1_234, thinkingTokenCount: 56, elapsedMs: 1_500,
  });
  renderer.render({ kind: 'tool_start', turn: 3, maxTurns: 24, command: 'git grep -n "x" src' });
  renderer.render({
    kind: 'tool_result',
    toolCallId: 'tc_0',
    turn: 3,
    maxTurns: 24,
    activityKind: 'search',
    command: 'git grep -n "x" src',
    exitCode: 0,
    outputSnippet: 'x',
    outputTokens: 57,
    outputTokensEstimated: false,
    promptTokenCount: 1_234,
    thinkingTokenCount: 56,
    elapsedMs: 2_000,
  });
  const lines = stderr.read().trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? '', /repo-search waiting for model lock \(1 queued, 4s\)/u);
  assert.match(lines[1] ?? '', /repo-search t3\/24 llm_start prompt=1,234tok \(56 thinking\)/u);
  assert.match(lines[2] ?? '', /repo-search t3\/24 git grep -n "x" src/u);
  assert.match(lines[3] ?? '', /repo-search t3\/24 done exit=0 57tok/u);
});

test('token-bearing events that fail validation render as a bare kind line, never as n/a counts', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({ kind: 'llm_start', turn: 3, maxTurns: 24, promptTokenCount: 1_234 });
  renderer.render({ kind: 'tool_result', turn: 3, maxTurns: 24, command: 'git grep', exitCode: 0 });
  const output = stderr.read();
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /repo-search t3\/24 llm_start$/u);
  assert.match(lines[1] ?? '', /repo-search t3\/24 tool_result$/u);
  assert.equal(output.includes('n/a'), false);
});

test('skips thinking and answer events and renders unknown kinds by name', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'summary');
  renderer.render({ kind: 'thinking', thinkingText: 'hidden' });
  renderer.render({ kind: 'answer', answerText: 'hidden' });
  renderer.render({ kind: 'core_start', provider: 'real' });
  const lines = stderr.read().trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /summary core_start/u);
});

test('SilentProgressRenderer renders nothing', () => {
  const stderr = makeCaptureStream();
  const renderer = new SilentProgressRenderer(stderr.stream, 'eval');
  renderer.render({ kind: 'core_start' });
  assert.equal(stderr.read(), '');
});

test('forCli renders per-turn lines only when showProgress is true', () => {
  const shown = makeCaptureStream();
  CliProgressRenderer.forCli(shown.stream, 'repo-search', true).render({ kind: 'core_start' });
  assert.match(shown.read(), /repo-search core_start/u);

  const hidden = makeCaptureStream();
  CliProgressRenderer.forCli(hidden.stream, 'repo-search', false).render({ kind: 'core_start' });
  assert.equal(hidden.read(), '');
});

test('warning-only renderer prints context warnings without --progress', () => {
  const stderr = makeCaptureStream();
  const renderer = CliProgressRenderer.forCli(stderr.stream, 'summary', false);
  renderer.render({
    kind: 'context_warning',
    warningText: "Autoload file 'missing.md' skipped: does not exist.",
  });

  assert.match(stderr.read(), /missing\.md.*does not exist/u);
});

test('renders approval_auto events with verdict, toolName, and reason', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-agent');
  renderer.render({
    kind: 'approval_auto',
    turn: 5,
    maxTurns: 24,
    toolName: 'write',
    verdict: 'approve',
    reason: 'task-scoped write',
  });
  const lines = stderr.read().trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /repo-agent t5\/24 auto-approval approve: write — task-scoped write/u);
});

test('renders activity_summary as multi-line stderr output with categories, counts, labels, and failed markers', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({
    kind: 'activity_summary',
    turn: 10,
    maxTurns: 45,
    entries: [
      { category: 'read_files', label: 'src/foo.ts', failed: false },
      { category: 'read_files', label: 'src/bar.ts', failed: false },
      { category: 'commands', label: 'npm test', failed: true },
      { category: 'edited_files', label: 'src/baz.ts', failed: false },
    ],
  });
  const output = stderr.read();
  const lines = output.trim().split('\n');
  assert.ok(lines.some((l) => l.includes('activity summary t10/45')));
  assert.ok(lines.some((l) => l.includes('read_files (2)')));
  assert.ok(lines.some((l) => l.includes('src/foo.ts')));
  assert.ok(lines.some((l) => l.includes('src/bar.ts')));
  assert.ok(lines.some((l) => l.includes('commands (1)')));
  assert.ok(lines.some((l) => l.includes('npm test [failed]')));
  assert.ok(lines.some((l) => l.includes('edited_files (1)')));
  assert.ok(lines.some((l) => l.includes('src/baz.ts')));
});

test('warning-only renderer forwards activity_summary but hides tool_start', () => {
  const stderr = makeCaptureStream();
  const renderer = CliProgressRenderer.forCli(stderr.stream, 'repo-search', false);
  renderer.render({ kind: 'tool_start', turn: 3, maxTurns: 24, command: 'git grep' });
  renderer.render({
    kind: 'activity_summary',
    turn: 10,
    maxTurns: 45,
    entries: [{ category: 'read_files', label: 'x.ts', failed: false }],
  });
  const output = stderr.read();
  assert.ok(!output.includes('tool_start'), 'tool_start must be hidden');
  assert.ok(output.includes('activity summary'), 'activity_summary must be shown');
  assert.ok(output.includes('read_files'), 'category must be shown');
});

test('warning-only renderer forwards context_warning alongside activity_summary', () => {
  const stderr = makeCaptureStream();
  const renderer = CliProgressRenderer.forCli(stderr.stream, 'repo-search', false);
  renderer.render({ kind: 'context_warning', warningText: 'missing.md skipped' });
  renderer.render({
    kind: 'activity_summary',
    turn: 10,
    maxTurns: 45,
    entries: [{ category: 'commands', label: 'echo hi', failed: false }],
  });
  const output = stderr.read();
  assert.ok(output.includes('missing.md'), 'context_warning must be shown');
  assert.ok(output.includes('activity summary'), 'activity_summary must be shown');
});

test('an activity_summary that fails validation renders as a bare kind line', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({
    kind: 'activity_summary',
    turn: 10,
    maxTurns: 45,
    entries: [{ category: 'unknown_category', label: 'x.ts', failed: false }],
  });
  const lines = stderr.read().trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /repo-search t10\/45 activity_summary$/u);
});
