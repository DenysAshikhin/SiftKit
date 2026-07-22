# Status Server Log Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status server's flat `process.stdout.write` logging with a levelled, colour-coded, repeat-suppressing logger, and collapse the three highest-volume log families (terminal-metadata drain waits, repo-search preflight, repo-search commands) so a normal run produces roughly one line per meaningful event instead of one per second.

**Architecture:** Every server log line already funnels through a single `logLine` function. Replace it with a `ServerLogger` class that owns level filtering, an ANSI palette gated on TTY/`NO_COLOR`, and a `RepeatSuppressor` that folds an unbounded run of identical events into an entry line plus an exit line carrying the total elapsed span. Then rewrite the three noisy emitters to use it. No shim, no dual-format period — `logLine` is deleted.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:test` via `dist/scripts/run-tests.js`, ANSI SGR escapes (no dependency).

---

## Background: the measured problem

A single 106-second repo-search window produced:

```
2026-07-21 20:42:37 status terminal_metadata_drain_wait request_id=813b39b4-d050-421e-879d-905180d38513 state=completed wait_ms=1000 active=true queue_length=4 model_queue_length=1
2026-07-21 20:42:38 status terminal_metadata_drain_wait request_id=813b39b4-d050-421e-879d-905180d38513 state=completed wait_ms=1000 active=true queue_length=4 model_queue_length=1
… ~100 more byte-identical lines except the timestamp …
```

emitted from [core.ts:566-570](../../../src/status-server/routes/core.ts#L566-L570), which re-logs on every re-schedule of `drainTerminalMetadataQueue`.

Each repo-search turn emits four lines that repeat the same request id, turn and token count:

```
2026-07-21 20:42:37 repo_search preflight_tokenize_start request_id=ddda7acf-fe04-45b8-9005-2180c3327878 turn=4 prompt_chars=102949 timeout_ms=10000 retry_max_wait_ms=30000
2026-07-21 20:42:37 repo_search preflight_done        request_id=ddda7acf-… turn=4 prompt_tokens=32944 elapsed_ms=31195
2026-07-21 20:42:37 repo_search preflight_tokenize_done request_id=ddda7acf-… turn=4 prompt_tokens=32944 source=llama.cpp elapsed_ms=111 retry_count=0 status=completed
```

from [execute.ts:41-67](../../../src/repo-search/execute.ts#L41-L67).

Facts verified:

1. Every server log line goes through `logLine` ([managed-llama.ts:621-623](../../../src/status-server/managed-llama.ts#L621-L623)) — 39 call sites across 7 files (`repo-search/execute.ts`, `status-server/managed-llama-flush-queue.ts`, `status-server/managed-llama.ts`, `status-server/server-ops.ts`, `status-server/routes/inference-passthrough.ts`, `status-server/routes/core.ts`, `status-server/routes/chat.ts`).
2. There is no log-level concept anywhere. `SIFTKIT_LLAMA_VERBOSE_LOGGING` ([managed-llama.ts:822](../../../src/status-server/managed-llama.ts#L822)) is an env var handed to the llama.cpp child process, not a SiftKit logging control.
3. `formatTimestamp` ([text-format.ts:3-11](../../../src/lib/text-format.ts#L3-L11)) emits `YYYY-MM-DD HH:MM:SS` on every line.
4. `formatElapsed` exists twice with different output: [text-format.ts:13](../../../src/lib/text-format.ts#L13) (`1:23`) and [time.ts:39](../../../src/lib/time.ts#L39) (`1m 23s`). The logger uses the `time.ts` form.
5. The repo-search command log message is built by `buildRepoSearchProgressLogMessage` ([dashboard-runs.ts:188-208](../../../src/status-server/dashboard-runs.ts#L188-L208)), called from [chat.ts:1155](../../../src/status-server/routes/chat.ts#L1155) and the repo-search progress path.

## Target format

`HH:MM:SS  <scope> <id8>  <event>  <fields>` — two spaces between groups, key=val retained only where grepping matters.

| Before (3 lines) | After (1 line) |
|---|---|
| `2026-07-21 20:42:37 repo_search preflight_tokenize_start request_id=ddda7acf-… turn=4 prompt_chars=102949 timeout_ms=10000 retry_max_wait_ms=30000`<br>`2026-07-21 20:42:37 repo_search preflight_done request_id=ddda7acf-… turn=4 prompt_tokens=32944 elapsed_ms=31195`<br>`2026-07-21 20:42:37 repo_search preflight_tokenize_done request_id=ddda7acf-… turn=4 prompt_tokens=32944 source=llama.cpp elapsed_ms=111 retry_count=0 status=completed` | `20:42:37  rs ddda7acf  preflight  t4/45  prompt=32,944tok/102.9kc  tokenize=111ms(llama.cpp)  elapsed=31s` |
| ~100 × `status terminal_metadata_drain_wait … wait_ms=1000 …` | `20:42:37  st 813b39b4  drain_wait  q=4 model_q=1`<br>`20:44:23  st 813b39b4  drain_resume  waited=1m 46s  q=4` |
| 3 × `repo_search command turn=4/45 prompt_tokens=32,944 elapsed=52s command=…` | `20:42:59  rs ddda7acf  commands  t4/45  3 cmds`<br>`                                   read  tests/runtime-db-schema-v29.test.ts  1+120`<br>`                                   grep  "ensureSchema\|getRuntime…"  tests/*.test.ts  ctx=2` |

Palette (ANSI SGR, applied only when colour is enabled):

| Element | Code |
|---|---|
| timestamp | `\x1b[2;37m` dim grey |
| scope (`rs`, `st`, `llama`, `chat`) | `\x1b[36m` cyan |
| id8 | `\x1b[2;35m` dim magenta |
| event verb | `\x1b[1m` bold |
| duration over 10s | `\x1b[33m` yellow |
| terminal `completed` / `ready` | `\x1b[32m` green |
| terminal `failed` / errors | `\x1b[31m` red |
| suppressed/queue/heartbeat lines | `\x1b[2m` dim |

Levels: `quiet` (warn + error + terminal only), `normal` (default), `debug` (everything). Selected by `SIFTKIT_LOG_LEVEL`. These events drop to `debug`: `preflight_start`, `preflight_tokenize_start`, `notify_running_done`, `terminal_metadata_enqueued`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/status-server/server-logger.ts` | `ServerLogger`, `Ansi` palette, level parsing | Create |
| `src/status-server/repeat-suppressor.ts` | Fold identical consecutive events into entry+exit | Create |
| [src/status-server/managed-llama.ts:621-623](../../../src/status-server/managed-llama.ts#L621-L623) | — | Delete `logLine` |
| [src/status-server/routes/core.ts](../../../src/status-server/routes/core.ts) | Drain-wait emitter | Use the suppressor |
| [src/repo-search/execute.ts:29-68](../../../src/repo-search/execute.ts#L29-L68) | Preflight emitter | Collapse four events into one |
| [src/status-server/dashboard-runs.ts:188-208](../../../src/status-server/dashboard-runs.ts#L188-L208) | Command log message | Compact form |
| `tests/server-logger.test.ts` | Logger unit coverage | Create |
| `tests/repeat-suppressor.test.ts` | Suppressor unit coverage | Create |

---

### Task 1: The logger

**Files:**
- Create: `src/status-server/server-logger.ts`
- Test: `tests/server-logger.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/server-logger.test.ts`:

```ts
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

test('error lines survive quiet level and carry the red SGR when colour is enabled', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'quiet', colour: true, write: sink.write });

  logger.error({ scope: 'st', id: 'abcdef12', event: 'spawn_failed', fields: 'exit=1' });

  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0].includes('\x1b[31m'), 'error lines must be red');
});

test('request ids are shortened to eight characters', () => {
  assert.equal(shortenRequestId('ddda7acf-fe04-45b8-9005-2180c3327878'), 'ddda7acf');
  assert.equal(shortenRequestId(''), '--------');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js server-logger
```

Expected: FAIL — `src/status-server/server-logger.ts` does not exist.

- [ ] **Step 3: Write the logger**

Create `src/status-server/server-logger.ts`:

```ts
import { z } from '../lib/zod.js';

const LogLevelSchema = z.enum(['quiet', 'normal', 'debug']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const LEVEL_RANK: Record<LogLevel, number> = { quiet: 0, normal: 1, debug: 2 };

export const Ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  timestamp: '\x1b[2;37m',
  scope: '\x1b[36m',
  id: '\x1b[2;35m',
  slow: '\x1b[33m',
  ok: '\x1b[32m',
  error: '\x1b[31m',
} as const;

export type ServerLogEvent = {
  scope: string;
  id: string;
  event: string;
  fields: string;
  date?: Date;
};

export function shortenRequestId(requestId: string): string {
  const normalized = String(requestId || '').trim();
  return normalized ? normalized.slice(0, 8) : '--------';
}

export function readLogLevelFromEnv(): LogLevel {
  return LogLevelSchema.catch('normal').parse(String(process.env.SIFTKIT_LOG_LEVEL || '').trim());
}

export function shouldUseColour(): boolean {
  if (String(process.env.NO_COLOR || '').trim()) {
    return false;
  }
  if (String(process.env.FORCE_COLOR || '').trim()) {
    return true;
  }
  return process.stdout.isTTY === true;
}

function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export type ServerLoggerOptions = {
  level: LogLevel;
  colour: boolean;
  write: (text: string) => void;
};

export class ServerLogger {
  private readonly level: LogLevel;
  private readonly colour: boolean;
  private readonly writeText: (text: string) => void;

  constructor(options: ServerLoggerOptions) {
    this.level = options.level;
    this.colour = options.colour;
    this.writeText = options.write;
  }

  debug(event: ServerLogEvent): void {
    this.emit(event, 'debug', '');
  }

  event(event: ServerLogEvent): void {
    this.emit(event, 'normal', '');
  }

  dim(event: ServerLogEvent): void {
    this.emit(event, 'normal', Ansi.dim);
  }

  ok(event: ServerLogEvent): void {
    this.emit(event, 'quiet', Ansi.ok);
  }

  error(event: ServerLogEvent): void {
    this.emit(event, 'quiet', Ansi.error);
  }

  /** Continuation lines for grouped events; indented to the field column, never coloured. */
  continuation(text: string): void {
    if (LEVEL_RANK[this.level] < LEVEL_RANK.normal) {
      return;
    }
    this.writeText(`${' '.repeat(35)}${text}\n`);
  }

  private paint(text: string, code: string): string {
    return this.colour && code ? `${code}${text}${Ansi.reset}` : text;
  }

  private emit(event: ServerLogEvent, minimumLevel: LogLevel, eventColour: string): void {
    if (LEVEL_RANK[this.level] < LEVEL_RANK[minimumLevel]) {
      return;
    }
    const clock = this.paint(formatClock(event.date ?? new Date()), Ansi.timestamp);
    const scope = this.paint(event.scope, Ansi.scope);
    const id = this.paint(shortenRequestId(event.id), Ansi.id);
    const verb = this.paint(event.event, eventColour || Ansi.bold);
    const fields = event.fields ? `  ${event.fields}` : '';
    this.writeText(`${clock}  ${scope} ${id}  ${verb}${fields}\n`);
  }
}

export const serverLogger = new ServerLogger({
  level: readLogLevelFromEnv(),
  colour: shouldUseColour(),
  write: (text: string) => { process.stdout.write(text); },
});
```

Note `emit`'s level semantics: `minimumLevel` is the *lowest* configured level at which the line still prints. `error`/`ok` pass `'quiet'` so they survive every level; `debug` passes `'debug'` so it only prints at `debug`.

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js server-logger
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/server-logger.ts tests/server-logger.test.ts
git commit -m "feat: add levelled colour-aware ServerLogger"
```

---

### Task 2: The repeat suppressor

**Files:**
- Create: `src/status-server/repeat-suppressor.ts`
- Test: `tests/repeat-suppressor.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/repeat-suppressor.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { RepeatSuppressor } from '../src/status-server/repeat-suppressor.js';

test('an unbroken run of identical events logs once on entry and once on release', () => {
  const lines: string[] = [];
  const suppressor = new RepeatSuppressor();

  const first = suppressor.observe('drain:813b39b4', 1_000);
  assert.equal(first.shouldLog, true);
  assert.equal(first.repeatCount, 0);
  lines.push('entry');

  for (let at = 2_000; at <= 10_000; at += 1_000) {
    assert.equal(suppressor.observe('drain:813b39b4', at).shouldLog, false);
  }

  const released = suppressor.release('drain:813b39b4', 11_000);
  assert.equal(released.repeatCount, 9);
  assert.equal(released.elapsedMs, 10_000);
  lines.push('exit');

  assert.deepEqual(lines, ['entry', 'exit']);
});

test('a different key restarts the run', () => {
  const suppressor = new RepeatSuppressor();
  assert.equal(suppressor.observe('a', 0).shouldLog, true);
  assert.equal(suppressor.observe('b', 1).shouldLog, true);
  assert.equal(suppressor.observe('b', 2).shouldLog, false);
});

test('releasing a key that was never observed reports nothing', () => {
  const suppressor = new RepeatSuppressor();
  assert.equal(suppressor.release('missing', 5), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repeat-suppressor
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the suppressor**

Create `src/status-server/repeat-suppressor.ts`:

```ts
export type RepeatObservation = {
  shouldLog: boolean;
  repeatCount: number;
};

export type RepeatRelease = {
  repeatCount: number;
  elapsedMs: number;
};

/**
 * Folds an unbroken run of identical events into one entry line and one release line.
 * Callers own the message text; this only answers "is this the first of a run?" and
 * "how long / how many did the run cover?".
 */
export class RepeatSuppressor {
  private activeKey: string | null = null;
  private startedAtMs = 0;
  private repeatCount = 0;

  observe(key: string, nowMs: number): RepeatObservation {
    if (this.activeKey === key) {
      this.repeatCount += 1;
      return { shouldLog: false, repeatCount: this.repeatCount };
    }
    this.activeKey = key;
    this.startedAtMs = nowMs;
    this.repeatCount = 0;
    return { shouldLog: true, repeatCount: 0 };
  }

  release(key: string, nowMs: number): RepeatRelease | null {
    if (this.activeKey !== key) {
      return null;
    }
    const release: RepeatRelease = {
      repeatCount: this.repeatCount,
      elapsedMs: Math.max(0, nowMs - this.startedAtMs),
    };
    this.activeKey = null;
    this.startedAtMs = 0;
    this.repeatCount = 0;
    return release;
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repeat-suppressor
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/repeat-suppressor.ts tests/repeat-suppressor.test.ts
git commit -m "feat: add RepeatSuppressor for folding identical log runs"
```

---

### Task 3: Retire `logLine`

**Files:**
- Modify: [src/status-server/managed-llama.ts:621-623](../../../src/status-server/managed-llama.ts#L621-L623) and all 39 call sites

The migration is mechanical: each existing message is already `"<scope> <event> key=val …"`, so it decomposes cleanly.

- [ ] **Step 1: Enumerate the call sites**

```bash
npx rg -n "logLine\(" src
```

Expected: 39 hits across `repo-search/execute.ts` (1), `status-server/managed-llama-flush-queue.ts` (3), `status-server/managed-llama.ts` (12), `status-server/server-ops.ts` (7), `status-server/routes/inference-passthrough.ts` (1), `status-server/routes/core.ts` (14), `status-server/routes/chat.ts` (1).

- [ ] **Step 2: Delete `logLine`**

Remove [managed-llama.ts:621-623](../../../src/status-server/managed-llama.ts#L621-L623):

```ts
export function logLine(message: string, date: Date = new Date()): void {
  process.stdout.write(`${formatTimestamp(date)} ${message}\n`);
}
```

Remove the now-unused `formatTimestamp` import from that file if nothing else there uses it.

- [ ] **Step 3: Convert each call site**

For each hit, replace

```ts
logLine(`llama_start ready base_url=${baseUrl}`);
```

with

```ts
serverLogger.ok({ scope: 'llama', id: '', event: 'ready', fields: `base_url=${baseUrl}` });
```

Mapping rules — apply them uniformly:

| Old message shape | New call |
|---|---|
| `repo_search <event> request_id=X …` | `serverLogger.event({ scope: 'rs', id: X, event, fields })` |
| `status <event> request_id=X …` | `serverLogger.event({ scope: 'st', id: X, event, fields })` |
| `llama_start …` / `managed_llama …` | `serverLogger.event({ scope: 'llama', id: '', event, fields })` |
| terminal success (`ready`, `completed`, `run_done`) | `serverLogger.ok(...)` |
| terminal failure, `[spawn-error]`, `*_failed` | `serverLogger.error(...)` |
| `preflight_start`, `preflight_tokenize_start`, `notify_running_done`, `terminal_metadata_enqueued` | `serverLogger.debug(...)` |
| queue/heartbeat/wait lines | `serverLogger.dim(...)` |

Add `import { serverLogger } from '<relative>/status-server/server-logger.js';` to each file. In `repo-search/execute.ts` this replaces the existing `import { logLine } from '../status-server/managed-llama.js';` at [execute.ts:15](../../../src/repo-search/execute.ts#L15).

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck:test
```

Expected: exit 0. Any remaining `logLine` reference is a compile error — that is the checklist.

- [ ] **Step 5: Fix tests that assert on log text**

```bash
npx rg -n "logLine|buildStatusRequestLogMessage" tests
```

Update expected strings to the new format. Tests assert against the plain form because `shouldUseColour()` returns `false` when stdout is not a TTY, which is the case under the test runner — no colour stripping needed.

- [ ] **Step 6: Run the suite**

```bash
npm run build:test
node .\dist\scripts\run-tests.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "refactor: replace logLine with ServerLogger across the status server"
```

---

### Task 4: Collapse the drain-wait storm

**Files:**
- Modify: [src/status-server/routes/core.ts:555-573](../../../src/status-server/routes/core.ts#L555-L573)
- Test: `tests/status-server-drain-log.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/status-server-drain-log.test.ts`. Use the existing status-server test harness (see [tests/summary-status-server.test.ts](../../../tests/summary-status-server.test.ts), which already asserts on `terminal_metadata_drain_wait`) to drive a request that waits several drain cycles, capturing stdout.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

// Reuse the stdout-capturing status-server harness from tests/summary-status-server.test.ts.
import { runStatusServerScenarioCapturingStdout } from './_test-helpers.js';

test('a long drain wait logs once on entry and once on resume', async () => {
  const stdout = await runStatusServerScenarioCapturingStdout(async (server) => {
    await server.enqueueTerminalMetadataWithBusyModel({ waitCycles: 8 });
    await server.drainTerminalMetadata();
  });

  const waits = stdout.split('\n').filter((line) => line.includes('drain_wait'));
  const resumes = stdout.split('\n').filter((line) => line.includes('drain_resume'));

  assert.equal(waits.length, 1, 'the wait must be logged once, not once per cycle');
  assert.equal(resumes.length, 1, 'the resume must report the folded run');
  assert.match(resumes[0], /waited=/u);
});
```

If `_test-helpers.ts` has no such harness, add the two helpers there — this is the second consumer of stdout capture after `summary-status-server`, so it belongs in the shared helper file.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js status-server-drain-log
```

Expected: FAIL — 8 or 9 `drain_wait` lines, no `drain_resume`.

- [ ] **Step 3: Add the suppressor to the drain loop**

At the top of [core.ts](../../../src/status-server/routes/core.ts), next to the other module-level singletons around [core.ts:94](../../../src/status-server/routes/core.ts#L94):

```ts
const terminalMetadataDrainSuppressor = new RepeatSuppressor();
```

with `import { RepeatSuppressor } from '../repeat-suppressor.js';`.

Replace the wait branch at [core.ts:564-573](../../../src/status-server/routes/core.ts#L564-L573):

```ts
  const waitMs = getTerminalMetadataIdleWaitMs(ctx, nextItem.capturedAtMs);
  if (waitMs > 0) {
    logLine(
      `status terminal_metadata_drain_wait request_id=${nextItem.requestId} state=${nextItem.terminalState} `
      + `wait_ms=${Math.max(1, Math.trunc(waitMs))} active=${ctx.activeModelRequest ? 'true' : 'false'} `
      + `queue_length=${ctx.terminalMetadataQueue.length} model_queue_length=${ctx.modelRequestQueue.length}`,
    );
    scheduleTerminalMetadataDrain(ctx, waitMs);
    return;
  }
```

with:

```ts
  const waitMs = getTerminalMetadataIdleWaitMs(ctx, nextItem.capturedAtMs);
  const drainKey = `drain:${nextItem.requestId}:${nextItem.terminalState}`;
  if (waitMs > 0) {
    if (terminalMetadataDrainSuppressor.observe(drainKey, Date.now()).shouldLog) {
      serverLogger.dim({
        scope: 'st',
        id: nextItem.requestId,
        event: 'drain_wait',
        fields: `state=${nextItem.terminalState} q=${ctx.terminalMetadataQueue.length} model_q=${ctx.modelRequestQueue.length}`,
      });
    }
    scheduleTerminalMetadataDrain(ctx, waitMs);
    return;
  }
  const drainRelease = terminalMetadataDrainSuppressor.release(drainKey, Date.now());
  if (drainRelease) {
    serverLogger.dim({
      scope: 'st',
      id: nextItem.requestId,
      event: 'drain_resume',
      fields: `waited=${formatElapsed(drainRelease.elapsedMs)} cycles=${drainRelease.repeatCount} q=${ctx.terminalMetadataQueue.length}`,
    });
  }
```

Import `formatElapsed` from `../../lib/time.js` (the `1m 46s` form), not from `text-format.js`.

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js status-server-drain-log
```

Expected: PASS.

- [ ] **Step 5: Update the existing drain assertion**

```bash
node .\dist\scripts\run-tests.js summary-status-server
```

[tests/summary-status-server.test.ts](../../../tests/summary-status-server.test.ts) asserts on `terminal_metadata_drain_wait`; update it to `drain_wait`.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/core.ts tests/status-server-drain-log.test.ts tests/summary-status-server.test.ts tests/_test-helpers.ts
git commit -m "perf: fold the terminal-metadata drain-wait log storm into entry and resume lines"
```

---

### Task 5: Collapse the preflight quartet

**Files:**
- Modify: [src/repo-search/execute.ts:29-68](../../../src/repo-search/execute.ts#L29-L68)
- Test: `tests/repo-search-preflight-log.test.ts` (create)

`ProgressReporter` emits four events per turn ([progress-reporter.ts:45-71](../../../src/repo-search/engine/progress-reporter.ts#L45-L71)). Keep the events — the dashboard consumes them — but make the *log* emit one line, on `preflight_tokenize_done`, carrying everything the other three carried.

- [ ] **Step 1: Write the failing test**

Create `tests/repo-search-preflight-log.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ServerLogger } from '../src/status-server/server-logger.js';
import { logRepoSearchPreflight } from '../src/repo-search/execute.js';

test('one preflight line replaces the four preflight events', () => {
  const lines: string[] = [];
  const logger = new ServerLogger({ level: 'normal', colour: false, write: (t) => { lines.push(t); } });

  logRepoSearchPreflight(logger, 'ddda7acf-fe04-45b8-9005-2180c3327878', {
    turn: 4,
    maxTurns: 45,
    promptChars: 102_949,
    promptTokenCount: 32_944,
    tokenizeElapsedMs: 111,
    tokenCountSource: 'llama.cpp',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_195,
  });

  assert.equal(lines.length, 1);
  // The leading clock is wall-time, so assert on everything after it.
  assert.equal(
    lines[0].slice('20:42:37  '.length).trimEnd(),
    'rs ddda7acf  preflight  t4/45  prompt=32,944tok/102.9kc  tokenize=111ms(llama.cpp)  elapsed=31s',
  );
});

test('a failed tokenize is logged as an error with the message', () => {
  const lines: string[] = [];
  const logger = new ServerLogger({ level: 'quiet', colour: false, write: (t) => { lines.push(t); } });

  logRepoSearchPreflight(logger, 'ddda7acf', {
    turn: 1,
    maxTurns: 45,
    promptChars: 10,
    promptTokenCount: 0,
    tokenizeElapsedMs: 10_000,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 3,
    tokenizeStatus: 'failed',
    elapsedMs: 10_000,
    errorMessage: 'tokenize timed out',
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /retries=3/u);
  assert.match(lines[0], /tokenize timed out/u);
});
```

Drop the brittle exact-equality assertion if the timestamp makes it awkward — the four `assert.match` checks are the contract.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repo-search-preflight-log
```

Expected: FAIL — `logRepoSearchPreflight` is not exported.

- [ ] **Step 3: Rewrite the emitter**

Replace [execute.ts:29-68](../../../src/repo-search/execute.ts#L29-L68) with:

```ts
export type RepoSearchPreflightSummary = {
  turn: number;
  maxTurns: number;
  promptChars: number;
  promptTokenCount: number;
  tokenizeElapsedMs: number;
  tokenCountSource: string;
  tokenizeRetryCount: number;
  tokenizeStatus: string;
  elapsedMs: number;
  errorMessage?: string;
};

function formatKiloCharacters(characters: number): string {
  return `${(Math.max(0, characters) / 1000).toFixed(1)}kc`;
}

export function logRepoSearchPreflight(
  logger: ServerLogger,
  requestId: string,
  summary: RepoSearchPreflightSummary,
): void {
  const retries = summary.tokenizeRetryCount > 0 ? `  retries=${summary.tokenizeRetryCount}` : '';
  const fields = `t${summary.turn}/${summary.maxTurns}`
    + `  prompt=${formatInteger(summary.promptTokenCount)}tok/${formatKiloCharacters(summary.promptChars)}`
    + `  tokenize=${summary.tokenizeElapsedMs}ms(${summary.tokenCountSource})`
    + `  elapsed=${formatElapsed(summary.elapsedMs)}${retries}`;
  if (summary.tokenizeStatus !== 'completed') {
    logger.error({
      scope: 'rs',
      id: requestId,
      event: 'preflight',
      fields: `${fields}  status=${summary.tokenizeStatus}  ${summary.errorMessage ?? ''}`.trimEnd(),
    });
    return;
  }
  logger.event({ scope: 'rs', id: requestId, event: 'preflight', fields });
}

function logRepoSearchExecutionProgress(requestId: string, event: RepoSearchProgressEvent, startedAt: number): void {
  const elapsedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, Math.trunc(Number(event.elapsedMs))) : Date.now() - startedAt;
  if (event.kind === 'model_inventory_start') {
    serverLogger.debug({ scope: 'rs', id: requestId, event: 'inventory_start', fields: `elapsed=${formatElapsed(elapsedMs)}` });
    return;
  }
  if (event.kind === 'model_inventory_done') {
    serverLogger.event({
      scope: 'rs',
      id: requestId,
      event: 'inventory',
      fields: `models=${Math.max(0, Math.trunc(Number(event.modelCount || 0)))}  elapsed=${formatElapsed(elapsedMs)}`,
    });
    return;
  }
  if (event.kind === 'preflight_start' || event.kind === 'preflight_done' || event.kind === 'preflight_tokenize_start') {
    // Folded into the single preflight line emitted on preflight_tokenize_done.
    return;
  }
  if (event.kind === 'preflight_tokenize_done') {
    logRepoSearchPreflight(serverLogger, requestId, {
      turn: Math.max(1, Math.trunc(Number(event.turn || 1))),
      maxTurns: Math.max(1, Math.trunc(Number(event.maxTurns || 1))),
      promptChars: Math.max(0, Math.trunc(Number(event.promptChars || 0))),
      promptTokenCount: Math.max(0, Math.trunc(Number(event.promptTokenCount || 0))),
      tokenizeElapsedMs: Math.max(0, Math.trunc(Number(event.tokenizeElapsedMs || 0))),
      tokenCountSource: String(event.tokenCountSource || 'unknown'),
      tokenizeRetryCount: Math.max(0, Math.trunc(Number(event.tokenizeRetryCount || 0))),
      tokenizeStatus: String(event.tokenizeStatus || 'unknown'),
      elapsedMs,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    });
  }
}
```

Add imports: `serverLogger` and `ServerLogger` from `../status-server/server-logger.js`, `formatElapsed` from `../lib/time.js`, `formatInteger` from `../lib/text-format.js`. Delete the now-unused `logRepoSearchProgress` helper if no other emitter uses it — check with `npx rg -n "logRepoSearchProgress" src`.

- [ ] **Step 4: Run the tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repo-search-preflight-log
node .\dist\scripts\run-tests.js repo-search
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/execute.ts tests/repo-search-preflight-log.test.ts
git commit -m "perf: collapse the four repo-search preflight log lines into one"
```

---

### Task 6: Compact the command log

**Files:**
- Modify: [src/status-server/dashboard-runs.ts:188-208](../../../src/status-server/dashboard-runs.ts#L188-L208)
- Test: `tests/repo-search-command-log.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/repo-search-command-log.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoSearchProgressLogMessage } from '../src/status-server/dashboard-runs.js';

test('a command log line drops default arguments and repeats no turn header per command', () => {
  const message = buildRepoSearchProgressLogMessage(
    {
      kind: 'turn_command_result',
      turn: 4,
      maxTurns: 45,
      promptTokenCount: 32_944,
      elapsedMs: 52_000,
      command: {
        command: 'grep',
        pattern: 'ensureSchema|getRuntimeDatabase',
        path: 'tests',
        glob: '*.test.ts',
        ignoreCase: false,
        literal: false,
        context: 2,
        limit: 50,
      },
    },
    'repo_search',
  );

  assert.ok(message);
  assert.match(message, /t4\/45/u);
  assert.doesNotMatch(message, /ignoreCase=false/u, 'default flags must not be printed');
  assert.doesNotMatch(message, /prompt_tokens=/u, 'the verbose key must be replaced by the compact form');
});
```

Match the actual `RepoSearchProgressEvent` shape by reading [src/repo-search/types.ts](../../../src/repo-search/types.ts) first; the object above is illustrative of the fields the formatter reads.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repo-search-command-log
```

Expected: FAIL on the `ignoreCase=false` assertion.

- [ ] **Step 3: Fix the escaped template literal bug while you are here**

[dashboard-runs.ts:191](../../../src/status-server/dashboard-runs.ts#L191) contains a `\${…}` escape inside a template literal, so `turnLabel` renders the literal text `${Number.isFinite(...) ? ... : '?'}` instead of the max-turns number. That is why the sample logs show `turn=4/45` only by luck of the surrounding string. Replace:

```ts
  const turnLabel = Number.isFinite(Number(event?.turn))
    ? `${Math.max(1, Math.trunc(Number(event?.turn)))}\${Number.isFinite(Number(event?.maxTurns)) ? Math.max(1, Math.trunc(Number(event?.maxTurns))) : '?'}`
    : '?/?';
```

with:

```ts
  const maxTurnsLabel = Number.isFinite(Number(event?.maxTurns))
    ? String(Math.max(1, Math.trunc(Number(event?.maxTurns))))
    : '?';
  const turnLabel = Number.isFinite(Number(event?.turn))
    ? `t${Math.max(1, Math.trunc(Number(event?.turn)))}/${maxTurnsLabel}`
    : 't?/?';
```

- [ ] **Step 4: Compact the message**

Replace the two `return` statements at [dashboard-runs.ts:200-207](../../../src/status-server/dashboard-runs.ts#L200-L207):

```ts
  if (kind === 'llm_start' || kind === 'llm_end') {
    return `${resolvedMode} ${kind} ${turnLabel}  prompt=${promptTokenCount}tok  elapsed=${formatElapsed(elapsedMs)}`;
  }
  const commandText = normalizeRepoSearchCommandForLog(event?.command);
  if (!commandText) {
    return null;
  }
  return `${resolvedMode} command ${turnLabel}  ${commandText}`;
```

Then update `normalizeRepoSearchCommandForLog` to omit arguments equal to their default — `ignoreCase=false`, `literal=false`, and any `limit` matching the tool's default — and to render `read` as `read <path>  <offset>+<limit>`. Find that function with:

```bash
npx rg -n "function normalizeRepoSearchCommandForLog" src
```

- [ ] **Step 5: Run the tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js repo-search-command-log
node .\dist\scripts\run-tests.js dashboard-status-server
```

Expected: PASS. Update any existing assertion on the old `command turn=4/45 prompt_tokens=…` shape.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/dashboard-runs.ts tests/repo-search-command-log.test.ts
git commit -m "perf: compact repo-search command log lines and fix the escaped turn label"
```

---

### Task 7: Document and verify

**Files:**
- Modify: [README.md](../../../README.md) or the operations doc that covers env vars — find it with `npx rg -n "SIFTKIT_STATUS_PORT" *.md docs`

- [ ] **Step 1: Document the two new env vars**

Add to whichever doc lists `SIFTKIT_*` variables:

```markdown
| `SIFTKIT_LOG_LEVEL` | `quiet` \| `normal` \| `debug` | `normal` | Status-server log verbosity. `quiet` keeps only terminal and error lines; `debug` adds preflight-start, notify and enqueue tracing. |
| `NO_COLOR` / `FORCE_COLOR` | any non-empty value | unset | Force colour off / on. Colour is otherwise enabled only when stdout is a TTY. |
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Eyeball a real run**

```bash
npm run build
npm run start:status:stable
```

In a second shell, issue one repo-search and confirm: a single `preflight` line per turn, one `commands` line per turn, at most two drain lines per terminal request, and colour present in the TTY. Then re-run with `SIFTKIT_LOG_LEVEL=quiet` and confirm only terminal and error lines appear.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document SIFTKIT_LOG_LEVEL and colour control"
```

---

## Deliberate non-goals

- **Structured JSON logs.** The consumer is a human tailing a console. If a machine consumer appears later, add a `json` level rather than reshaping every call site.
- **Log file rotation.** The status server writes to stdout; the supervisor owns capture and rotation.
- **Touching `traceRepoSearch`.** That is a separate opt-in trace channel ([repo-search/logging.ts](../../../src/repo-search/logging.ts)) with its own gate, not part of the default console stream.
