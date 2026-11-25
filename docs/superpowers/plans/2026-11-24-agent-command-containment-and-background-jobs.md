# Agent Command Containment and Background Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No command an agent starts can leave a process behind or exhaust the server's memory, and an agent can run a long command in the background under the same guarantees.

**Architecture:** Every agent command runs in a PowerShell shell that first puts itself in a kill-on-close Windows job object, so the kernel ends whatever the command started. Output goes through a fixed-size window instead of an unbounded string. Background jobs are the same contained command, owned by one run and disposed before that run releases its lock and its repository.

**Tech Stack:** TypeScript (type-stripped by Node), node:test, zod, Windows PowerShell 5.1, Win32 job objects through `Add-Type`.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-command-containment-and-background-jobs-design.md`

---

## Before you start

- **Base:** `904137b6`. `diff` blocks apply to that commit; `Create` blocks are whole files. If a hunk no longer applies, make the same change by hand. Do not weaken it.
- **No commits.** Each task ends with a green tree, not a commit.
- **No live run:** the code must not change while a watched server is running an agent. Check first.
- **Order matters.** Tasks 1 to 3 are Part 1 and can ship alone. Task 4 does not start until Part 1's tests pass (the spec's rule).
- Node-suite tests may not start child processes; tests that do live in `tests/process/` and run with `--process`.
- All code below ran in a scratch copy of the repository at the base commit. Results are in "What was measured".

## Where the plan differs from the spec

| Spec | Plan | Why |
|---|---|---|
| `src/lib/agent-command.ts` | `src/repo-search/engine/agent-command.ts` | It logs through `serverLogger`; `src/lib` must not import the status server |
| `spawnAgentCommand`, `runCapturedCommand` | `startAgentCommand` / `runAgentCommand`, class `CapturedCommand` | A job needs the running command (stop, output so far), not only its result |
| `BackgroundJobSlots` on `ServerContext` | Owned by `RepoAgentSessionManager` | It is the only user; nothing else reaches for it |
| "An orderly shutdown aborts sessions" | Shutdown only disposes every run's jobs | Today shutdown aborts orchestrator children, not chat or CLI runs. Changing that is a separate behaviour change |
| `dispose()` in `run()`'s `finally` | In the `finally` around the engine call | It must also precede the published outcome, or a caller could act on a finished run whose job still writes |
| Jobs end at finish | They also end **before** the submission gate | A child's checks and diff run inside finish; they must not race a job |
| `output` option name | `outputPolicy` | `output` already names the result text |

An approval wait releases the model lock by design, so on an approval timeout the lock is already free when jobs are disposed. The repository lease is not, and that is what the test checks.

The run's answer names killed jobs only when it is prose. A schema answer (an orchestrator child's report) must still parse, so there the note is only logged.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/bounded-output.ts` (new) | Keeps a fixed window or fails past a limit; `copyText` |
| `src/lib/captured-command.ts` | One spawned command: capture, timeout, abort, stop, settle |
| `src/lib/powershell.ts` | PowerShell invocation, with an optional prelude |
| `src/repo-search/engine/agent-command.ts` (new) | The job-object prelude and its limits; the only way to start agent input |
| `src/repo-search/engine/background-jobs.ts` (new) | Jobs of one run, and the server's slots |
| `src/repo-search/engine/shell-command-policy.ts` | Refuses the forms that escape any job |
| `src/status-server/repo-agent-sessions.ts` | Creates a run's jobs and disposes them |

---

## Part 1: containment

### Task 1: Bounded output

A byte window that never grows past its size, and a limit that fails instead of cutting. A V8 slice keeps its whole parent string alive, so every kept tail goes through `copyText`.

**Files:**
- `tests/bounded-output.test.ts`
- `src/lib/bounded-output.ts`

- [ ] **Step 1: Write the tests**

Create `tests/bounded-output.test.ts`:

````ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { z } from 'zod';

import { BoundedOutput, copyText } from '../src/lib/bounded-output.ts';

const MIB = 1024 * 1024;
setFlagsFromString('--expose-gc');
const collect = z.custom<() => void>((value) => typeof value === 'function').parse(runInNewContext('gc'));
const droppedNote = (bytes: number) => `\n[${bytes} bytes of output dropped here: only the start and end were kept.]\n`;

function write(output: BoundedOutput, text: string, chunkBytes: number): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += chunkBytes) output.write(bytes.subarray(at, at + chunkBytes));
}

test('output at or under the window is kept whole, whatever the chunks', () => {
  for (const chunkBytes of [1, 3, 7, 100]) {
    for (const length of [0, 1, 4, 5, 9, 10]) {
      const output = new BoundedOutput({ kind: 'window', headBytes: 4, tailBytes: 6 });
      const text = 'abcdefghij'.slice(0, length);
      write(output, text, chunkBytes);
      assert.equal(output.text(), text, `${length} bytes in chunks of ${chunkBytes}`);
      assert.equal(output.dropped, 0);
    }
  }
});

test('output over the window keeps its start and end and names what it dropped', () => {
  for (const chunkBytes of [1, 2, 5, 6, 7, 11, 1000]) {
    for (const length of [11, 12, 17, 26]) {
      const output = new BoundedOutput({ kind: 'window', headBytes: 4, tailBytes: 6 });
      const text = 'abcdefghijklmnopqrstuvwxyz'.slice(0, length);
      write(output, text, chunkBytes);
      assert.equal(output.text(), `${text.slice(0, 4)}${droppedNote(length - 10)}${text.slice(-6)}`, `${length} bytes in chunks of ${chunkBytes}`);
      assert.equal(output.dropped, length - 10);
    }
  }
});

test('a character cut at either edge of the window is dropped whole', () => {
  for (const character of ['é', 'ℹ', '😀']) {
    for (let headBytes = 0; headBytes < 9; headBytes += 1) {
      for (let tailBytes = 1; tailBytes < 9; tailBytes += 1) {
        const output = new BoundedOutput({ kind: 'window', headBytes, tailBytes });
        write(output, character.repeat(20), 5);
        assert.ok(!output.text().includes('�'), `${character} head ${headBytes} tail ${tailBytes}: ${output.text()}`);
      }
    }
  }
});

test('a limit keeps exactly its bytes and reports the first one past it', () => {
  const output = new BoundedOutput({ kind: 'limit', bytes: 5 });
  output.write(Buffer.from('12345'));
  assert.deepEqual([output.text(), output.dropped], ['12345', 0]);
  output.write(Buffer.from('6'));
  assert.equal(output.dropped, 1);
});

test('memory follows the output up to the window and is freed on release', () => {
  const output = new BoundedOutput({ kind: 'window', headBytes: 2 * MIB, tailBytes: 6 * MIB });
  output.write(Buffer.from('x'));
  assert.ok(output.capacity <= 64 * 1024, String(output.capacity));
  const chunk = Buffer.alloc(64 * 1024, 97);
  for (let written = 0; written < 600 * MIB; written += chunk.length) output.write(chunk);
  assert.equal(output.capacity, 8 * MIB);
  output.release();
  assert.deepEqual([output.capacity, output.text()], [0, '']);
});

test('a copied tail does not keep the text it was cut from alive', async () => {
  assert.equal(copyText('héllo ✖'), 'héllo ✖');
  collect();
  const before = process.memoryUsage().heapUsed + process.memoryUsage().external;
  const tails: string[] = [];
  for (let index = 0; index < 20; index += 1) tails.push(copyText(Buffer.alloc(16 * MIB, 97 + index).toString('latin1').slice(-1_000)));
  // Buffers are freed off the main thread, after the collection that finds them dead.
  collect();
  await delay(100);
  collect();
  const grown = process.memoryUsage().heapUsed + process.memoryUsage().external - before;
  assert.equal(tails.length, 20);
  assert.ok(grown < 160 * MIB, `${Math.round(grown / MIB)} MiB kept for 20 tails of 1,000 characters`);
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts bounded-output`
Expected: FAIL (cannot find `src/lib/bounded-output.ts`)

- [ ] **Step 3: Implement**

Create `src/lib/bounded-output.ts`:

````ts
/** How much of one output stream is kept: both ends with the middle dropped, or everything up to a failing limit. */
export type OutputPolicy =
  | { kind: 'window'; headBytes: number; tailBytes: number }
  | { kind: 'limit'; bytes: number };

/** Output a caller parses: cutting it would change the answer, so passing the limit fails the command. */
export const PARSED_OUTPUT: OutputPolicy = { kind: 'limit', bytes: 64 * 1024 * 1024 };

const INITIAL_CAPACITY_BYTES = 64 * 1024;

/** A buffer that grows by doubling, so a short output never costs the whole allowance. */
function grown(buffer: Buffer, needed: number, maximum: number): Buffer {
  if (needed <= buffer.length) return buffer;
  const next = Buffer.allocUnsafe(Math.min(maximum, Math.max(needed, buffer.length * 2, INITIAL_CAPACITY_BYTES)));
  buffer.copy(next);
  return next;
}

/** How many bytes at the end of `buffer` belong to a UTF-8 sequence that was cut off. */
function cutSequenceAtEnd(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer.readUInt8(buffer.length - back);
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/** How many continuation bytes at the start of `buffer` belong to a sequence cut off before it. */
function cutSequenceAtStart(buffer: Buffer): number {
  let count = 0;
  while (count < Math.min(3, buffer.length) && (buffer.readUInt8(count) & 0xc0) === 0x80) count += 1;
  return count;
}

/** One output stream in bounded memory: its first bytes, then a ring of its last ones. */
export class BoundedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer = Buffer.alloc(0);
  private headLength = 0;
  private tail: Buffer = Buffer.alloc(0);
  private tailLength = 0;
  /** Where the next byte goes once the ring is full; the oldest byte sits there. */
  private tailNext = 0;
  private droppedBytes = 0;

  constructor(policy: OutputPolicy) {
    this.headLimit = policy.kind === 'window' ? policy.headBytes : policy.bytes;
    this.tailLimit = policy.kind === 'window' ? policy.tailBytes : 0;
  }

  /** Bytes that could not be kept; a limit that drops any has been exceeded. */
  get dropped(): number {
    return this.droppedBytes;
  }

  /** Bytes this stream holds in memory, for the leak tests. */
  get capacity(): number {
    return this.head.length + this.tail.length;
  }

  write(chunk: Buffer): void {
    const intoHead = Math.min(chunk.length, this.headLimit - this.headLength);
    if (intoHead > 0) {
      this.head = grown(this.head, this.headLength + intoHead, this.headLimit);
      chunk.copy(this.head, this.headLength, 0, intoHead);
      this.headLength += intoHead;
    }
    const rest = chunk.subarray(intoHead);
    if (rest.length > 0) this.writeTail(rest);
  }

  private writeTail(chunk: Buffer): void {
    if (chunk.length >= this.tailLimit) {
      this.droppedBytes += this.tailLength + chunk.length - this.tailLimit;
      this.tail = grown(this.tail, this.tailLimit, this.tailLimit);
      chunk.copy(this.tail, 0, chunk.length - this.tailLimit);
      this.tailLength = this.tailLimit;
      this.tailNext = 0;
      return;
    }
    const free = this.tailLimit - this.tailLength;
    if (free > 0) {
      const appended = Math.min(free, chunk.length);
      this.tail = grown(this.tail, this.tailLength + appended, this.tailLimit);
      chunk.copy(this.tail, this.tailLength, 0, appended);
      this.tailLength += appended;
      if (appended < chunk.length) this.overwriteOldest(chunk.subarray(appended));
      return;
    }
    this.overwriteOldest(chunk);
  }

  private overwriteOldest(chunk: Buffer): void {
    this.droppedBytes += chunk.length;
    const untilEnd = Math.min(chunk.length, this.tailLimit - this.tailNext);
    chunk.copy(this.tail, this.tailNext, 0, untilEnd);
    chunk.copy(this.tail, 0, untilEnd);
    this.tailNext = (this.tailNext + chunk.length) % this.tailLimit;
  }

  /** What was kept as text; a dropped middle is named in its place. */
  text(): string {
    const head = this.head.subarray(0, this.headLength);
    const tail = Buffer.concat([
      this.tail.subarray(this.tailNext, this.tailLength), this.tail.subarray(0, this.tailNext),
    ]);
    if (this.droppedBytes === 0) return Buffer.concat([head, tail]).toString('utf8');
    const headCut = cutSequenceAtEnd(head);
    const tailCut = cutSequenceAtStart(tail);
    const droppedBytes = this.droppedBytes + headCut + tailCut;
    return `${head.subarray(0, head.length - headCut).toString('utf8')}`
      + `\n[${droppedBytes} bytes of output dropped here: only the start and end were kept.]\n`
      + tail.subarray(tailCut).toString('utf8');
  }

  /** Frees the kept bytes; the stream reads as empty afterwards. */
  release(): void {
    this.head = Buffer.alloc(0);
    this.headLength = 0;
    this.tail = Buffer.alloc(0);
    this.tailLength = 0;
    this.tailNext = 0;
    this.droppedBytes = 0;
  }
}

/** A copy that shares no memory with `text`: a slice would keep the whole original alive. */
export function copyText(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts bounded-output`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/bounded-output.test.ts src/lib/bounded-output.ts`
Expected: both exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 2: CapturedCommand replaces runCapturedCommand

A complete replacement: `runCapturedCommand` is gone, so a missed caller fails to compile. Callers that parse output (`git`, `rg`, `nvidia-smi`, DPAPI) use `PARSED_OUTPUT` and keep the tree kill. Behaviour of every existing caller stays the same, except that more than 64 MiB on one stream is now an error. `PARSED_OUTPUT` failure is tested through the agent command suite in Task 3.

**Files:**
- `tests/helpers/agent-processes.ts`
- `src/lib/captured-command.ts`
- `src/lib/command-spawn.ts`
- `src/lib/powershell.ts`

- [ ] **Step 1: Write the tests**

Create `tests/helpers/agent-processes.ts`:

````ts
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { z } from 'zod';

const CountSchema = z.coerce.number().int().nonnegative();

/** A loopback address no other test uses; pings to it are the processes a test may leave behind. */
export function agentProcessMarker(): string {
  return `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(2, 255)}`;
}

/** Starts a detached child and an orphaned grandchild, both outliving the command unless contained. */
export function leaveProcessesCommand(marker: string): string {
  return `Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','120','${marker}'; `
    + `Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c','start /b ping -n 120 ${marker} >nul'`;
}

function queryMarked(marker: string, action: string): string {
  const filter = `Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*${marker}*' }`;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(${filter})${action}`], { encoding: 'utf8' }).stdout.trim();
}

export function countMarkedProcesses(marker: string): number {
  return CountSchema.parse(queryMarked(marker, '.Count'));
}

export function killMarkedProcesses(marker: string): void {
  queryMarked(marker, ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }');
}
````

- [ ] **Step 2: Run them and see them fail**

Run: `npx tsc -p tsconfig.test.json`
Expected: FAIL (nothing yet: this step only adds a helper, so the type-check passes. The existing suites in Step 4 are this task's tests; run them now and note that they pass)

- [ ] **Step 3: Implement**

Modify `src/lib/captured-command.ts`:

````diff
@@ -3,15 +3,16 @@
  *
  * Two rules make a captured command impossible to hang on:
  *
- * 1. A timeout terminates the whole process tree, not just the direct child. Signalling only the
- *    child leaves descendants alive, and on Windows they keep running indefinitely.
+ * 1. A timeout ends everything the command started: the process tree, or, for a command in a job
+ *    object, the one process whose end makes the kernel end the rest.
  * 2. Settlement is driven by `'exit'` with a bounded drain window, never by `'close'` alone.
  *    `'close'` waits for the stdio pipes, and a descendant that inherited them holds them open
  *    after the child is gone — which is exactly how a two-minute command froze a run for 17
  *    minutes. The normal path still settles on `'close'`, so complete output is the default.
  */
-import { spawn } from 'node:child_process';
+import { spawn, type ChildProcess } from 'node:child_process';
 
+import { BoundedOutput, type OutputPolicy } from './bounded-output.ts';
 import { terminateProcessTree } from './process-tree.ts';
 
 export type CapturedCommandResult = {
@@ -19,13 +20,22 @@ export type CapturedCommandResult = {
   stdout: string;
   stderr: string;
   output: string;
+  timedOut: boolean;
+  /** False when something the command started still held the output pipes 2 s after it exited. */
+  pipesClosed: boolean;
 };
 
+/** `tree` walks parent ids; `process` is enough only for a command that contains itself in a job object. */
+export type CommandTermination = 'tree' | 'process';
+
 export type CapturedCommandOptions = {
+  /** Applied to stdout and to stderr separately. */
+  outputPolicy: OutputPolicy;
+  termination: CommandTermination;
   cwd?: string;
   windowsHide?: boolean;
   abortSignal?: AbortSignal;
-  /** Wall-clock budget. When it elapses the process tree is terminated and `exitCode` is 124. */
+  /** Wall-clock budget. When it elapses the command is terminated and `exitCode` is 124. */
   timeoutMs?: number;
   /** The child's entire environment when provided; callers decide whether to merge or replace. */
   env?: Record<string, string>;
@@ -68,99 +78,138 @@ export function toStringRecord(source: Record<string, string | undefined>): Reco
  */
 const STDIO_DRAIN_GRACE_MS = 2_000;
 
-export function runCapturedCommand(
-  file: string,
-  args: string[],
-  options: CapturedCommandOptions = {},
-): Promise<CapturedCommandResult> {
-  return new Promise((resolve) => {
-    const child = spawn(file, args, {
+/** A running command: its output so far, a way to end it, and the result every ending settles. */
+export class CapturedCommand {
+  readonly result: Promise<CapturedCommandResult>;
+  private readonly child: ChildProcess;
+  private readonly options: CapturedCommandOptions;
+  private readonly stdout: BoundedOutput;
+  private readonly stderr: BoundedOutput;
+
+  constructor(file: string, args: string[], options: CapturedCommandOptions) {
+    this.options = options;
+    this.stdout = new BoundedOutput(options.outputPolicy);
+    this.stderr = new BoundedOutput(options.outputPolicy);
+    this.child = spawn(file, args, {
       cwd: options.cwd,
       windowsHide: options.windowsHide ?? true,
       stdio: [options.stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
       env: options.env,
     });
-    if (options.stdinData !== undefined && child.stdin !== null) {
+    if (options.stdinData !== undefined && this.child.stdin !== null) {
       // A child that exits without reading breaks the pipe; that must not crash this process.
-      child.stdin.on('error', () => undefined);
-      child.stdin.end(options.stdinData);
+      this.child.stdin.on('error', () => undefined);
+      this.child.stdin.end(options.stdinData);
     }
+    this.result = this.capture();
+  }
 
-    let stdout = '';
-    let stderr = '';
-    let spawnError: (Error & { code?: string }) | null = null;
-    let timedOut = false;
-    let settled = false;
-    let timeoutHandle: NodeJS.Timeout | null = null;
-    let drainHandle: NodeJS.Timeout | null = null;
-
-    const terminate = (): void => {
-      if (typeof child.pid === 'number' && child.pid > 0) {
-        terminateProcessTree(child.pid);
-        return;
-      }
-      child.kill();
-    };
+  get pid(): number | undefined {
+    return this.child.pid;
+  }
 
-    const settle = (code: number | null): void => {
-      if (settled) {
-        return;
-      }
-      settled = true;
-      if (timeoutHandle) clearTimeout(timeoutHandle);
-      if (drainHandle) clearTimeout(drainHandle);
-      options.abortSignal?.removeEventListener('abort', terminate);
-      // Nothing further is read, and leaving the pipes attached would keep this process's event
-      // loop alive on the very handles the drain window exists to escape.
-      child.stdout?.destroy();
-      child.stderr?.destroy();
-      child.unref();
-
-      const outputParts: string[] = [];
-      if (timedOut) {
-        outputParts.push(`timeout=${options.timeoutMs}ms exceeded; command was killed`);
-      }
-      if (spawnError) {
-        const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
-        outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
-      }
-      const textOutput = `${stdout}${stderr}`.trim();
-      if (textOutput) outputParts.push(textOutput);
-      resolve({
-        // A timeout reports 124 whatever the kill happened to produce: terminating a tree on
-        // Windows yields an ordinary exit code, which would otherwise read as a real result.
-        exitCode: timedOut
-          ? TIMEOUT_EXIT_CODE
-          : typeof code === 'number' ? code : (spawnError ? SPAWN_ERROR_EXIT_CODE : UNKNOWN_EXIT_CODE),
-        stdout,
-        stderr,
-        output: outputParts.join('\n').trim(),
-      });
-    };
+  /** Everything kept so far, stdout first; empty once the result has settled. */
+  outputSoFar(): string {
+    return `${this.stdout.text()}${this.stderr.text()}`;
+  }
 
-    if (options.abortSignal?.aborted) {
-      terminate();
-    } else {
-      options.abortSignal?.addEventListener('abort', terminate, { once: true });
-    }
-    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
-      timeoutHandle = setTimeout(() => {
-        timedOut = true;
-        terminate();
-      }, options.timeoutMs);
+  terminate(): void {
+    const { pid } = this.child;
+    if (this.options.termination === 'tree' && typeof pid === 'number' && pid > 0) {
+      terminateProcessTree(pid);
+      return;
     }
+    this.child.kill();
+  }
+
+  private capture(): Promise<CapturedCommandResult> {
+    const { child, options, stdout, stderr } = this;
+    return new Promise((resolve, reject) => {
+      let spawnError: (Error & { code?: string }) | null = null;
+      let timedOut = false;
+      let overLimit = false;
+      let settled = false;
+      let timeoutHandle: NodeJS.Timeout | null = null;
+      let drainHandle: NodeJS.Timeout | null = null;
+      const terminate = (): void => { this.terminate(); };
+
+      const settle = (code: number | null, pipesClosed: boolean): void => {
+        if (settled) {
+          return;
+        }
+        settled = true;
+        if (timeoutHandle) clearTimeout(timeoutHandle);
+        if (drainHandle) clearTimeout(drainHandle);
+        options.abortSignal?.removeEventListener('abort', terminate);
+        // Nothing further is read, and leaving the pipes attached would keep this process's event
+        // loop alive on the very handles the drain window exists to escape.
+        child.stdout?.destroy();
+        child.stderr?.destroy();
+        child.unref();
+        const stdoutText = stdout.text();
+        const stderrText = stderr.text();
+        stdout.release();
+        stderr.release();
+
+        if (overLimit && options.outputPolicy.kind === 'limit') {
+          reject(new Error(`Command output passed ${options.outputPolicy.bytes} bytes, so the command was stopped and its output discarded.`));
+          return;
+        }
+        const outputParts: string[] = [];
+        if (timedOut) {
+          outputParts.push(`timeout=${options.timeoutMs}ms exceeded; command was killed`);
+        }
+        if (spawnError) {
+          const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
+          outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
+        }
+        const textOutput = `${stdoutText}${stderrText}`.trim();
+        if (textOutput) outputParts.push(textOutput);
+        resolve({
+          // A timeout reports 124 whatever the kill happened to produce: terminating a tree on
+          // Windows yields an ordinary exit code, which would otherwise read as a real result.
+          exitCode: timedOut
+            ? TIMEOUT_EXIT_CODE
+            : typeof code === 'number' ? code : (spawnError ? SPAWN_ERROR_EXIT_CODE : UNKNOWN_EXIT_CODE),
+          stdout: stdoutText,
+          stderr: stderrText,
+          output: outputParts.join('\n').trim(),
+          timedOut,
+          pipesClosed,
+        });
+      };
+
+      const keep = (stream: BoundedOutput, chunk: Buffer): void => {
+        if (overLimit) return;
+        stream.write(chunk);
+        if (options.outputPolicy.kind === 'limit' && stream.dropped > 0) {
+          overLimit = true;
+          terminate();
+        }
+      };
 
-    child.stdout?.setEncoding('utf8');
-    child.stderr?.setEncoding('utf8');
-    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
-    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
-    child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
-    child.on('exit', (code) => {
-      if (drainHandle === null) {
-        drainHandle = setTimeout(() => settle(code), STDIO_DRAIN_GRACE_MS);
-        drainHandle.unref();
+      if (options.abortSignal?.aborted) {
+        terminate();
+      } else {
+        options.abortSignal?.addEventListener('abort', terminate, { once: true });
+      }
+      if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
+        timeoutHandle = setTimeout(() => {
+          timedOut = true;
+          terminate();
+        }, options.timeoutMs);
       }
+
+      child.stdout?.on('data', (chunk: Buffer) => { keep(stdout, chunk); });
+      child.stderr?.on('data', (chunk: Buffer) => { keep(stderr, chunk); });
+      child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
+      child.on('exit', (code) => {
+        if (drainHandle === null) {
+          drainHandle = setTimeout(() => { settle(code, false); }, STDIO_DRAIN_GRACE_MS);
+          drainHandle.unref();
+        }
+      });
+      child.on('close', (code) => { settle(code, true); });
     });
-    child.on('close', (code) => { settle(code); });
-  });
+  }
 }
````

Modify `src/lib/command-spawn.ts`:

````diff
@@ -1,4 +1,5 @@
-import { runCapturedCommand, type CapturedCommandResult } from './captured-command.ts';
+import { PARSED_OUTPUT } from './bounded-output.ts';
+import { CapturedCommand, type CapturedCommandResult } from './captured-command.ts';
 
 export type DirectCommandResult = CapturedCommandResult;
 
@@ -20,5 +21,5 @@ export function spawnDirectCommand(
   args: string[],
   options: DirectCommandOptions = {},
 ): Promise<DirectCommandResult> {
-  return runCapturedCommand(command, args, options);
+  return new CapturedCommand(command, args, { ...options, outputPolicy: PARSED_OUTPUT, termination: 'tree' }).result;
 }
````

Modify `src/lib/powershell.ts`:

````diff
@@ -6,7 +6,8 @@
 
 import { spawnSync, type StdioOptions, type SpawnSyncReturns } from 'node:child_process';
 
-import { runCapturedCommand, toStringRecord, type CapturedCommandResult } from './captured-command.ts';
+import { PARSED_OUTPUT, type OutputPolicy } from './bounded-output.ts';
+import { CapturedCommand, toStringRecord, type CapturedCommandResult, type CommandTermination } from './captured-command.ts';
 
 export const POWERSHELL_EXECUTABLE = 'powershell.exe';
 export const POWERSHELL_BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'] as const;
@@ -23,13 +24,13 @@ export const RUN_SHELL_LABEL = `PowerShell (Windows, ${POWERSHELL_EXECUTABLE})`;
 const POWERSHELL_UTF8_PRELUDE =
   '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false); ';
 
-function buildPowerShellInvocation(command: string, pipeStdin: boolean): string {
+function buildPowerShellInvocation(command: string, pipeStdin: boolean, prelude: string): string {
   const commandWithExitGuard = `${command}\nif (-not $?) { exit 1 }`;
   const escapedCommand = commandWithExitGuard.replaceAll("'", "''");
   const invokeCommand = `& ([ScriptBlock]::Create('${escapedCommand}'))`;
   return pipeStdin
-    ? `${POWERSHELL_UTF8_PRELUDE}[Console]::In.ReadToEnd() | ${invokeCommand}`
-    : `${POWERSHELL_UTF8_PRELUDE}${invokeCommand}`;
+    ? `${POWERSHELL_UTF8_PRELUDE}${prelude}[Console]::In.ReadToEnd() | ${invokeCommand}`
+    : `${POWERSHELL_UTF8_PRELUDE}${prelude}${invokeCommand}`;
 }
 
 /**
@@ -45,6 +46,12 @@ function buildPowerShellInvocation(command: string, pipeStdin: boolean): string
  */
 export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
 export const MAX_RUN_TIMEOUT_MS = 600_000;
+/** The same bounds for a run started with `background: true`. */
+export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000;
+export const MAX_BACKGROUND_TIMEOUT_MS = 3_600_000;
+/** How long one `job` wait may hold the run. */
+export const DEFAULT_JOB_WAIT_MS = 120_000;
+export const MAX_JOB_WAIT_MS = 600_000;
 
 // ---------------------------------------------------------------------------
 // Synchronous
@@ -63,7 +70,7 @@ export function spawnPowerShellSync(
 ): SpawnSyncReturns<string> {
   return spawnSync(
     POWERSHELL_EXECUTABLE,
-    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, false)],
+    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, false, '')],
     {
       cwd: options.cwd,
       encoding: options.encoding ?? 'utf8',
@@ -90,16 +97,25 @@ export type PowerShellAsyncOptions = {
   stdinData?: string;
 };
 
+/** How a shell is captured, and PowerShell source that runs in it before the command does. */
+export type PowerShellStartOptions = PowerShellAsyncOptions & {
+  prelude: string;
+  outputPolicy: OutputPolicy;
+  termination: CommandTermination;
+};
+
+export function startPowerShell(command: string, options: PowerShellStartOptions): CapturedCommand {
+  const { prelude, env, ...captured } = options;
+  return new CapturedCommand(
+    POWERSHELL_EXECUTABLE,
+    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, options.stdinData !== undefined, prelude)],
+    { ...captured, env: env ? { ...toStringRecord(process.env), ...env } : undefined },
+  );
+}
+
 export function spawnPowerShellAsync(
   command: string,
   options: PowerShellAsyncOptions = {},
 ): Promise<PowerShellAsyncResult> {
-  return runCapturedCommand(
-    POWERSHELL_EXECUTABLE,
-    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, options.stdinData !== undefined)],
-    {
-      ...options,
-      env: options.env ? { ...toStringRecord(process.env), ...options.env } : undefined,
-    },
-  );
+  return startPowerShell(command, { ...options, prelude: '', outputPolicy: PARSED_OUTPUT, termination: 'tree' }).result;
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts --process command-spawn powershell-async`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/helpers/agent-processes.ts src/lib/captured-command.ts src/lib/command-spawn.ts src/lib/powershell.ts`
Expected: both exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 3: Agent commands run in a job object

The prelude compiles a P/Invoke class, creates a kill-on-close job with 16 GiB and 128 processes, and puts the shell in it. If any of that fails the command does not run and the exit code is 125. `executeRun`, orchestrator checks and the check preflight move over; `dpapi.ts` keeps `spawnPowerShellAsync`.

**Files:**
- `tests/helpers/agent-command-host.ts`
- `tests/process/agent-command.test.ts`
- `src/repo-search/engine/agent-command.ts`
- `src/repo-search/engine/repo-tools.ts`
- `src/orchestrator/verification.ts`
- `src/orchestrator/check-preflight.ts`

- [ ] **Step 1: Write the tests**

Create `tests/helpers/agent-command-host.ts`:

````ts
// A stand-in for the status server: it starts one agent command and waits, so a test can force-kill it.
import { runAgentCommand } from '../../src/repo-search/engine/agent-command.ts';

const command = process.argv[2];
if (command === undefined) throw new Error('The host needs a command.');
await runAgentCommand(command, { cwd: process.cwd(), timeoutMs: 120_000 });
````

Create `tests/process/agent-command.test.ts`:

````ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { CapturedCommand } from '../../src/lib/captured-command.ts';
import { spawnDirectCommand } from '../../src/lib/command-spawn.ts';
import { startPowerShell } from '../../src/lib/powershell.ts';
import { buildJobPrelude, runAgentCommand, startAgentCommand } from '../../src/repo-search/engine/agent-command.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';

const CWD = process.cwd();
const TIMEOUT_MS = 60_000;

function printBytes(bytes: number): string {
  return `& '${process.execPath}' -e "const c = Buffer.alloc(65536, 97); let n = ${bytes}; const next = () => { while (n > 0) { const k = Math.min(n, c.length); n -= k; if (!process.stdout.write(c.subarray(0, k))) { process.stdout.once('drain', next); return; } } }; next();"`;
}

test('a contained command keeps exit codes, output, grammar and encoding', async () => {
  const run = (command: string) => runAgentCommand(command, { cwd: CWD, timeoutMs: TIMEOUT_MS });
  const ok = await run('param(); Write-Output 42');
  assert.deepEqual([ok.exitCode, ok.stdout, ok.timedOut, ok.pipesClosed], [0, '42\r\n', false, true]);
  assert.equal((await run('exit 3')).exitCode, 3);
  assert.equal((await run(`& '${process.execPath}' -e "process.exit(7)"`)).exitCode, 1);
  const glyphs = await run(`& '${process.execPath}' -e "console.log('\\u2139 caf\\u00e9')" | ForEach-Object { $_ }`);
  assert.equal(glyphs.stdout, 'ℹ café\r\n');
});

for (const ending of ['normal exit', 'timeout', 'abort', 'terminate'] as const) {
  test(`nothing a command started outlives it: ${ending}`, async (t) => {
    const marker = agentProcessMarker();
    t.after(() => { killMarkedProcesses(marker); });
    const abort = new AbortController();
    const running = startAgentCommand(`${leaveProcessesCommand(marker)}; Write-Output ready; ${ending === 'normal exit' ? 'Start-Sleep 2' : 'Start-Sleep 120'}`, {
      cwd: CWD, abortSignal: abort.signal, timeoutMs: ending === 'timeout' ? 8_000 : TIMEOUT_MS,
    });
    while (countMarkedProcesses(marker) < 2) await delay(100);
    if (ending === 'abort') abort.abort(new Error('stopped'));
    if (ending === 'terminate') running.terminate();
    const result = await running.result;
    assert.equal(result.timedOut, ending === 'timeout');
    assert.equal(result.exitCode === 124, ending === 'timeout');
    await delay(500);
    assert.equal(countMarkedProcesses(marker), 0);
  });
}

test('nothing a command started outlives a server that is force-killed', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const server = spawn(process.execPath, [path.resolve('tests/helpers/agent-command-host.ts'), `${leaveProcessesCommand(marker)}; Start-Sleep 120`], { stdio: 'ignore' });
  while (countMarkedProcesses(marker) < 2) await delay(100);
  server.kill('SIGKILL');
  await delay(1_500);
  assert.equal(countMarkedProcesses(marker), 0);
});

test('a command that cannot be contained does not run', async () => {
  const result = await runAgentCommand('Write-Output SHOULD_NOT_RUN', { cwd: CWD, timeoutMs: TIMEOUT_MS,
    env: { TEMP: 'Z:\\missing', TMP: 'Z:\\missing' } });
  assert.equal(result.exitCode, 125);
  assert.match(result.output, /could not be contained/u);
  assert.doesNotMatch(result.output, /SHOULD_NOT_RUN/u);
});

test('600 MB of output keeps its window and leaves this process small', async () => {
  const before = process.memoryUsage().rss;
  const result = await runAgentCommand(`Write-Output first; ${printBytes(600 * 1024 * 1024)}`, { cwd: CWD, timeoutMs: TIMEOUT_MS });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^first\r?\n/u);
  assert.match(result.stdout, /\[\d+ bytes of output dropped here/u);
  assert.ok(result.stdout.length < 9 * 1024 * 1024, String(result.stdout.length));
  const grew = (process.memoryUsage().rss - before) / 1024 / 1024;
  assert.ok(grew < 150, `grew ${Math.round(grew)} MiB`);
});

test('a parsed command past its limit fails without a partial result', async () => {
  const script = 'process.stdout.write(Buffer.alloc(2000, 97))';
  const start = (bytes: number) => new CapturedCommand(process.execPath, ['-e', script], { outputPolicy: { kind: 'limit', bytes }, termination: 'tree' });
  assert.equal((await start(2000).result).stdout.length, 2000);
  await assert.rejects(start(1999).result, /passed 1999 bytes/u);
  assert.equal((await spawnDirectCommand(process.execPath, ['-e', script])).stdout.length, 2000);
});

test('the job refuses memory and processes past its limits', async () => {
  const limited = (command: string) => startPowerShell(command, { cwd: CWD, timeoutMs: TIMEOUT_MS, termination: 'process',
    outputPolicy: { kind: 'limit', bytes: 100_000 }, prelude: buildJobPrelude({ memoryGib: 1, processes: 3 }) }).result;
  const memory = await limited(`& '${process.execPath}' -e "const held = []; for (let i = 0; i < 2; i += 1) held.push(Buffer.alloc(1024 ** 3, 1)); console.log('ALLOCATED')"`);
  assert.notEqual(memory.exitCode, 0);
  assert.doesNotMatch(memory.output, /ALLOCATED/u);
  const processes = await limited("1..6 | ForEach-Object { Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','30','127.0.0.1' }");
  assert.match(processes.stderr, /Start-Process :/u);
});

test('a process outside the job that holds the pipes cannot keep a command open', async () => {
  const command = new CapturedCommand(process.execPath, ['-e',
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true }).unref(); process.exit(0)"],
  { outputPolicy: { kind: 'limit', bytes: 1000 }, termination: 'process' });
  const startedAt = Date.now();
  const result = await command.result;
  assert.deepEqual([result.exitCode, result.pipesClosed], [0, false]);
  assert.ok(Date.now() - startedAt < 6_000);
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts --process agent-command`
Expected: FAIL (cannot find `agent-command.ts`)

- [ ] **Step 3: Implement**

Create `src/repo-search/engine/agent-command.ts`:

````ts
/**
 * Every shell command an agent starts. The shell puts itself in a Windows job object before it runs
 * the command, and holds the job's only handle, so the kernel ends whatever is left when it ends.
 */
import { serverLogger } from '../../status-server/server-logger.ts';
import type { OutputPolicy } from '../../lib/bounded-output.ts';
import { CapturedCommand, type CapturedCommandResult } from '../../lib/captured-command.ts';
import { startPowerShell } from '../../lib/powershell.ts';

/** What a command and its descendants may hold together: committed memory, and live processes with the shell itself. */
export type AgentJobLimits = { memoryGib: number; processes: number };
const AGENT_JOB_LIMITS: AgentJobLimits = { memoryGib: 16, processes: 128 };
/** The shell could not contain itself, so the command never ran. */
export const CONTAINMENT_FAILED_EXIT_CODE = 125;
/** Kept of each output stream; the middle of a longer one is dropped. */
const AGENT_OUTPUT: OutputPolicy = { kind: 'window', headBytes: 2 * 1024 * 1024, tailBytes: 6 * 1024 * 1024 };

/** PowerShell that puts the shell running it in a job, or exits 125 before the command runs. */
export function buildJobPrelude(limits: AgentJobLimits): string {
  // 0x2000 KILL_ON_JOB_CLOSE, 0x200 JOB_MEMORY, 0x8 ACTIVE_PROCESS. BREAKAWAY_OK is never set.
  return String.raw`
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SiftKitAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint ActiveProcessLimit; public UIntPtr e; public uint f, g; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, int length);
  [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  public static void Enter(ulong memoryBytes, uint processes) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended limits = new Extended();
    limits.Basic.LimitFlags = 0x2000 | 0x200 | 0x8;
    limits.Basic.ActiveProcessLimit = processes;
    limits.JobMemory = (UIntPtr)memoryBytes;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
  }
}
'@
  [SiftKitAgentJob]::Enter(${limits.memoryGib}GB, ${limits.processes})
} catch {
  [Console]::Error.WriteLine("Command not run: it could not be contained. $($_.Exception.Message)")
  exit ${CONTAINMENT_FAILED_EXIT_CODE}
}
`;
}

const AGENT_JOB_PRELUDE = buildJobPrelude(AGENT_JOB_LIMITS);

export type AgentCommandOptions = {
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Merged over the inherited environment. */
  env?: Record<string, string>;
  stdinData?: string;
};

export function startAgentCommand(command: string, options: AgentCommandOptions): CapturedCommand {
  if (process.platform !== 'win32') throw new Error('Agent commands run only on Windows.');
  const running = startPowerShell(command, {
    ...options, prelude: AGENT_JOB_PRELUDE, outputPolicy: AGENT_OUTPUT, termination: 'process',
  });
  void running.result.then((result) => {
    if (result.pipesClosed) return;
    serverLogger.emitBody('agent', String(running.pid ?? 'unknown'), {
      event: 'agent_command_pipes_open', severity: 'warning',
      fields: 'a process outside the command\'s job still held its output pipes after it ended',
    });
  }, () => undefined);
  return running;
}

export async function runAgentCommand(command: string, options: AgentCommandOptions): Promise<CapturedCommandResult> {
  const result = await startAgentCommand(command, options).result;
  return result.pipesClosed ? result : { ...result, output: `${result.output}\n\n${PIPES_OPEN_WARNING}`.trim() };
}

export const PIPES_OPEN_WARNING = 'Warning: something this command started outside its job is still running and may have kept output.';
````

Modify `src/repo-search/engine/repo-tools.ts`:

````diff
@@ -14,7 +14,8 @@ import { formatRejectedCallCut } from '../../planner-protocol/native-actions.ts'
 import { containsUnifiedDiff } from '../../tool-loop-governor.ts';
 import { spawnDirectCommand } from '../../lib/command-spawn.ts';
 import { buildAgentRunEnv } from '../../lib/agent-run-marker.ts';
-import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../../lib/powershell.ts';
+import { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from '../../lib/powershell.ts';
+import { runAgentCommand } from './agent-command.ts';
 import type {
   EditToolArgs,
   FindToolArgs,
@@ -273,7 +274,15 @@ export function buildRepoToolRequestedCommand(toolName: string, args: JsonObject
     return formatToolCommand('run', [
       ['command', readString(args.command)],
       ['outputMode', optionalString(args.outputMode)],
-      ['timeoutMs', parsePositiveInteger(args.timeoutMs)],
+      ['timeoutMs', parsePositiveInteger(args.timeoutMs) ?? (args.background === true ? DEFAULT_BACKGROUND_TIMEOUT_MS : undefined)],
+      ['background', args.background === true ? true : undefined],
+    ]);
+  }
+  if (toolName === 'job') {
+    return formatToolCommand('job', [
+      ['action', readString(args.action)],
+      ['jobId', optionalString(args.jobId)],
+      ['waitMs', parsePositiveInteger(args.waitMs)],
     ]);
   }
   if (toolName === 'git') {
@@ -963,7 +972,7 @@ function executeEdit(args: EditToolArgs, context: RepoToolContext): RepoToolExec
 
 async function executeRun(args: RunToolArgs, context: RepoToolContext): Promise<RepoToolExecution> {
   const command = buildRepoToolRequestedCommand('run', args);
-  const result = await spawnPowerShellAsync(args.command, {
+  const result = await runAgentCommand(args.command, {
     cwd: context.repoRoot,
     abortSignal: context.abortSignal,
     timeoutMs: args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
````

Modify `src/orchestrator/verification.ts`:

````diff
@@ -8,9 +8,11 @@ import type {
   OrchestratorVerificationCheck,
 } from '@siftkit/contracts';
 
+import { copyText } from '../lib/bounded-output.ts';
 import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.ts';
 import { describeFileLines } from '../lib/source-lines.ts';
-import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../lib/powershell.ts';
+import { DEFAULT_RUN_TIMEOUT_MS } from '../lib/powershell.ts';
+import { runAgentCommand } from '../repo-search/engine/agent-command.ts';
 import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
 import { cutDigest, digestOutput } from '../output-digest/digest.ts';
 
@@ -35,14 +37,14 @@ export async function runVerificationCheck(input: {
   const { check } = input;
   const cwd = resolveRepoScopedPath(input.repoRoot, check.cwd);
   if (cwd === null) throw new Error(`Verification cwd '${check.cwd}' escapes the repository.`);
-  const result = await spawnPowerShellAsync(check.command, {
+  const result = await runAgentCommand(check.command, {
     cwd: cwd.absolutePath, abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
   });
   input.abortSignal.throwIfAborted();
   // The digest reads the whole output; the stored output keeps its tail and the stored digest its head.
   const digest = digestOutput(result.output);
   return { check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
-    output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS), digest: digest === null ? null : cutDigest(digest.text, CHECK_OUTPUT_MAX_CHARS) };
+    output: copyText(result.output.slice(-CHECK_OUTPUT_MAX_CHARS)), digest: digest === null ? null : copyText(cutDigest(digest.text, CHECK_OUTPUT_MAX_CHARS)) };
 }
 
 function normalizeCode(text: string): string {
````

Modify `src/orchestrator/check-preflight.ts`:

````diff
@@ -1,7 +1,8 @@
 import type { OrchestratorVerificationCheck } from '@siftkit/contracts';
 
 import { parseJsonValueText } from '../lib/json.ts';
-import { RUN_SHELL_LABEL, spawnPowerShellAsync } from '../lib/powershell.ts';
+import { RUN_SHELL_LABEL } from '../lib/powershell.ts';
+import { runAgentCommand } from '../repo-search/engine/agent-command.ts';
 import { z } from '../lib/zod.ts';
 
 const PREFLIGHT_MARKER = 'SIFTKIT_CHECK_PREFLIGHT:';
@@ -35,7 +36,7 @@ export async function findUnrunnableChecks(repoRoot: string, checks: readonly Or
   abortSignal: AbortSignal): Promise<string[]> {
   const commands = [...new Set(checks.flatMap((check) => (check.kind === 'command' ? [check.command] : [])))];
   if (commands.length === 0) return [];
-  const result = await spawnPowerShellAsync(PREFLIGHT_SCRIPT, { cwd: repoRoot, abortSignal, timeoutMs: PREFLIGHT_TIMEOUT_MS,
+  const result = await runAgentCommand(PREFLIGHT_SCRIPT, { cwd: repoRoot, abortSignal, timeoutMs: PREFLIGHT_TIMEOUT_MS,
     stdinData: JSON.stringify(commands) });
   abortSignal.throwIfAborted();
   const line = result.output.split(/\r?\n/u).find((entry) => entry.startsWith(PREFLIGHT_MARKER));
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts --process agent-command command-spawn powershell-async repo-tools orchestrator-check workspace read-only-git dpapi`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/helpers/agent-command-host.ts tests/process/agent-command.test.ts src/repo-search/engine/agent-command.ts src/repo-search/engine/repo-tools.ts src/orchestrator/verification.ts src/orchestrator/check-preflight.ts`
Expected: both exit 0 with no output.

- [ ] **Step 5: Prove the fallbacks are real**

Change `0x2000 | 0x200 | 0x8` to `0x200 | 0x8` in `agent-command.ts` and run `node .\src\test-runner\run-tests.ts --process agent-command`.
Expected: the endings tests FAIL with processes left over. Restore the flag; they pass again.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.


## Part 2: background jobs

### Task 4: BackgroundJobs and its slots

Two jobs per run, four per server, the last eight results kept. A slot comes back only at a confirmed exit. Nothing uses this class yet.

**Files:**
- `tests/process/background-jobs.test.ts`
- `src/repo-search/engine/background-jobs.ts`

- [ ] **Step 1: Write the tests**

Create `tests/process/background-jobs.test.ts`:

````ts
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { runAgentCommand } from '../../src/repo-search/engine/agent-command.ts';
import { BackgroundJobs, BackgroundJobSlots, type JobReply } from '../../src/repo-search/engine/background-jobs.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';

const TIMEOUT_MS = 60_000;

function makeJobs(t: TestContext, slots = new BackgroundJobSlots()): BackgroundJobs {
  const jobs = new BackgroundJobs(slots);
  t.after(() => jobs.dispose());
  return jobs;
}

function start(jobs: BackgroundJobs, command: string, timeoutMs = TIMEOUT_MS): JobReply {
  return jobs.start({ command, cwd: process.cwd(), timeoutMs, env: {} });
}

function outputOf(reply: JobReply): string {
  assert.ok(reply.ok, reply.ok ? '' : reply.reason);
  return reply.output;
}

function refusalOf(reply: JobReply): string {
  assert.ok(!reply.ok);
  return reply.reason;
}

test('a job gives the result its command gives in the foreground', async (t) => {
  const command = 'Write-Output one; Write-Output two; exit 3';
  const foreground = await runAgentCommand(command, { cwd: process.cwd(), timeoutMs: TIMEOUT_MS });
  const jobs = makeJobs(t);
  assert.match(outputOf(start(jobs, command)), /Started background job j1/u);
  const reply = await jobs.wait('j1', TIMEOUT_MS, undefined);
  assert.ok(reply.ok);
  assert.equal(reply.exitCode, foreground.exitCode);
  assert.match(reply.output, /one\r?\ntwo\n\[job j1 exited 3 after \d+ s\]$/u);
  assert.equal(outputOf(jobs.output('j1')), reply.output, 'the result can be read again');
});

test('a wait that runs out shows the output so far and leaves the job running', async (t) => {
  const jobs = makeJobs(t);
  start(jobs, 'Write-Output started; Start-Sleep 60');
  let text = '';
  for (let tries = 0; tries < 40 && !text.includes('started'); tries += 1) text = outputOf(await jobs.wait('j1', 250, undefined));
  assert.match(text, /started\n\[job j1 running for \d+ s\]$/u);
  assert.equal(outputOf(await jobs.wait('j1', 50, undefined)).includes('running'), true, 'an identical wait is answered again');
  assert.match(outputOf(await jobs.stop('j1')), /\[job j1 stopped after \d+ s\]$/u);
  assert.match(outputOf(await jobs.stop('j1')), /stopped/u, 'stopping a stopped job returns its result');
});

test('a job past its time is killed with everything it started', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const jobs = makeJobs(t);
  start(jobs, `${leaveProcessesCommand(marker)}; Start-Sleep 120`, 6_000);
  const reply = await jobs.wait('j1', TIMEOUT_MS, undefined);
  assert.ok(reply.ok);
  assert.equal(reply.exitCode, 124);
  assert.match(reply.output, /timed out/u);
  await delay(500);
  assert.equal(countMarkedProcesses(marker), 0);
});

test('a run has two jobs, a server four, and a slot comes back only when a job has ended', async (t) => {
  const slots = new BackgroundJobSlots();
  const [first, second, third] = [makeJobs(t, slots), makeJobs(t, slots), makeJobs(t, slots)];
  const sleep = 'Start-Sleep 60';
  outputOf(start(first, sleep));
  outputOf(start(first, sleep));
  assert.match(refusalOf(start(first, sleep)), /already has 2 background jobs running \(j1, j2\)/u);
  outputOf(start(second, sleep));
  outputOf(start(second, sleep));
  assert.match(refusalOf(start(third, sleep)), /all 4 background jobs of this server are in use/u);
  await first.stop('j1');
  assert.equal(slots.inUse, 3);
  outputOf(start(third, sleep));
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  assert.equal(slots.inUse, 0);
});

test('dispose kills every job, ends pending waits, and refuses new work', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const slots = new BackgroundJobSlots();
  const jobs = makeJobs(t, slots);
  start(jobs, `${leaveProcessesCommand(marker)}; Start-Sleep 120`);
  while (countMarkedProcesses(marker) < 2) await delay(100);
  const waiting = jobs.wait('j1', TIMEOUT_MS, undefined);
  await Promise.all([jobs.dispose(), jobs.dispose()]);
  assert.match(outputOf(await waiting), /stopped/u);
  assert.equal(slots.inUse, 0);
  await delay(500);
  assert.equal(countMarkedProcesses(marker), 0);
  assert.match(refusalOf(start(jobs, 'Write-Output late')), /run is ending/u);
  assert.match(refusalOf(jobs.output('j1')), /no background job "j1"; known jobs: none/u);
});

test('an aborted wait rejects and leaves nothing behind', async (t) => {
  const jobs = makeJobs(t);
  start(jobs, 'Start-Sleep 60');
  const abort = new AbortController();
  const waiting = jobs.wait('j1', TIMEOUT_MS, abort.signal);
  abort.abort(new Error('stopped by user'));
  await assert.rejects(waiting, /stopped by user/u);
  await assert.rejects(jobs.wait('j1', TIMEOUT_MS, abort.signal), /stopped by user/u);
});

test('a result names the files written while the job ran, and only those', async (t) => {
  const jobs = makeJobs(t);
  jobs.noteChangedPath('src/before.ts');
  start(jobs, 'Start-Sleep 1');
  jobs.noteChangedPath('src/during.ts');
  await jobs.wait('j1', TIMEOUT_MS, undefined);
  jobs.noteChangedPath('src/after.ts');
  assert.match(outputOf(jobs.output('j1')), /Files this run wrote while it ran: src\/during\.ts\n/u);
});

test('only the last eight results are kept', async (t) => {
  const jobs = makeJobs(t);
  for (let index = 1; index <= 10; index += 1) {
    start(jobs, `Write-Output job${index}`);
    await jobs.wait(`j${index}`, TIMEOUT_MS, undefined);
  }
  assert.match(refusalOf(jobs.output('j2')), /Only the last 8 finished results are kept/u);
  assert.match(outputOf(jobs.output('j3')), /job3/u);
  assert.equal(outputOf(jobs.list()).split('\n').length, 9);
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts --process background-jobs`
Expected: FAIL (cannot find `background-jobs.ts`)

- [ ] **Step 3: Implement**

Create `src/repo-search/engine/background-jobs.ts`:

````ts
import { getAbortError } from '../../lib/abort.ts';
import { copyText } from '../../lib/bounded-output.ts';
import { TIMEOUT_EXIT_CODE, type CapturedCommand } from '../../lib/captured-command.ts';
import { cutDigest, digestOutput } from '../../output-digest/digest.ts';
import { PIPES_OPEN_WARNING, startAgentCommand } from './agent-command.ts';

const JOBS_PER_RUN = 2;
const JOBS_PER_SERVER = 4;
/** Finished jobs whose results a run can still ask for. */
const RESULTS_KEPT = 8;
/** Characters of a job's output kept once it ends; the digest reads all of it first. */
const RESULT_MAX_CHARS = 200_000;
const DIGEST_MAX_CHARS = 20_000;
const LIVE_TAIL_CHARS = 8_000;
const LISTED_COMMAND_CHARS = 120;

function lastChars(text: string, count: number): string {
  return text.length <= count ? text : copyText(text.slice(-count));
}

function formatSeconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)} s`;
}

/** Running jobs across every run of the server. */
export class BackgroundJobSlots {
  private used = 0;

  get inUse(): number {
    return this.used;
  }

  tryTake(): boolean {
    if (this.used >= JOBS_PER_SERVER) return false;
    this.used += 1;
    return true;
  }

  release(): void {
    if (this.used === 0) throw new Error('A background job slot was released twice.');
    this.used -= 1;
  }
}

type JobOutcome = { label: string; exitCode: number; elapsedMs: number; output: string; digest: string | null };

type Job = {
  readonly id: string;
  readonly command: string;
  readonly startedAtMs: number;
  readonly changedPaths: Set<string>;
  readonly waiters: Set<() => void>;
  stopRequested: boolean;
  /** Null once the job has ended, so its output window is free to collect. */
  running: CapturedCommand | null;
  outcome: JobOutcome | null;
  /** Settles when the job has ended and its slot is back. */
  ended: Promise<void>;
};

export type JobReply = { ok: true; exitCode: number; output: string; digest: string | null } | { ok: false; reason: string };

export type StartJobInput = { command: string; cwd: string; timeoutMs: number; env: Record<string, string> };

/** Every background job of one run. Nothing it starts outlives `dispose`. */
export class BackgroundJobs {
  private readonly slots: BackgroundJobSlots;
  private readonly jobs = new Map<string, Job>();
  private nextId = 1;
  private disposal: Promise<void> | null = null;

  constructor(slots: BackgroundJobSlots) {
    this.slots = slots;
  }

  start(input: StartJobInput): JobReply {
    if (this.disposal) return { ok: false, reason: 'the run is ending; no background job can start' };
    const running = this.running();
    if (running.length >= JOBS_PER_RUN) {
      return { ok: false, reason: `this run already has ${JOBS_PER_RUN} background jobs running (${running.map((job) => job.id).join(', ')}); wait for or stop one first` };
    }
    if (!this.slots.tryTake()) {
      return { ok: false, reason: `all ${JOBS_PER_SERVER} background jobs of this server are in use; run the command in the foreground or try later` };
    }
    let command: CapturedCommand;
    try {
      command = startAgentCommand(input.command, { cwd: input.cwd, timeoutMs: input.timeoutMs, env: input.env });
    } catch (error) {
      this.slots.release();
      throw error;
    }
    const job: Job = {
      id: `j${this.nextId}`, command: input.command, startedAtMs: Date.now(), changedPaths: new Set(), waiters: new Set(),
      stopRequested: false, running: command, outcome: null, ended: Promise.resolve(),
    };
    this.nextId += 1;
    this.jobs.set(job.id, job);
    job.ended = this.settle(job, command);
    return { ok: true, exitCode: 0, digest: null,
      output: `Started background job ${job.id} (limit ${formatSeconds(input.timeoutMs)}). Use job with action wait, output or stop; it is killed when this run ends.` };
  }

  private async settle(job: Job, command: CapturedCommand): Promise<void> {
    let outcome: JobOutcome;
    try {
      const result = await command.result;
      const label = result.timedOut ? 'timed out' : job.stopRequested ? 'stopped' : `exited ${result.exitCode}`;
      const digest = digestOutput(result.output);
      const output = result.pipesClosed ? result.output : `${result.output}\n\n${PIPES_OPEN_WARNING}`;
      outcome = {
        label, exitCode: result.timedOut ? TIMEOUT_EXIT_CODE : result.exitCode, elapsedMs: Date.now() - job.startedAtMs,
        output: lastChars(output, RESULT_MAX_CHARS),
        digest: digest === null ? null : copyText(cutDigest(digest.text, DIGEST_MAX_CHARS)),
      };
    } catch (error) {
      outcome = { label: 'failed', exitCode: 1, elapsedMs: Date.now() - job.startedAtMs, digest: null,
        output: error instanceof Error ? error.message : String(error) };
    } finally {
      this.slots.release();
      job.running = null;
    }
    job.outcome = outcome;
    this.forgetOldResults();
    for (const wake of job.waiters) wake();
    job.waiters.clear();
  }

  private forgetOldResults(): void {
    const finished = [...this.jobs.values()].filter((job) => job.outcome !== null);
    for (const job of finished.slice(0, Math.max(0, finished.length - RESULTS_KEPT))) this.jobs.delete(job.id);
  }

  running(): { id: string; command: string; elapsedMs: number }[] {
    return [...this.jobs.values()].filter((job) => job.running !== null)
      .map((job) => ({ id: job.id, command: job.command, elapsedMs: Date.now() - job.startedAtMs }));
  }

  /** Records a file this run wrote while jobs were running, so their results can say so. */
  noteChangedPath(path: string): void {
    for (const job of this.jobs.values()) if (job.running !== null) job.changedPaths.add(path);
  }

  async wait(jobId: string, waitMs: number, abortSignal: AbortSignal | undefined): Promise<JobReply> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return this.unknown(jobId);
    if (job.outcome === null) await this.waitForEnd(job, waitMs, abortSignal);
    return this.report(job);
  }

  private waitForEnd(job: Job, waitMs: number, abortSignal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        job.waiters.delete(wake);
        abortSignal?.removeEventListener('abort', onAbort);
      };
      const wake = (): void => { cleanup(); resolve(); };
      const onAbort = (): void => { cleanup(); reject(getAbortError(abortSignal)); };
      const timer = setTimeout(wake, waitMs);
      job.waiters.add(wake);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();
    });
  }

  output(jobId: string): JobReply {
    const job = this.jobs.get(jobId);
    return job === undefined ? this.unknown(jobId) : this.report(job);
  }

  async stop(jobId: string): Promise<JobReply> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return this.unknown(jobId);
    this.kill(job);
    await job.ended;
    return this.report(job);
  }

  private kill(job: Job): void {
    if (job.running === null) return;
    job.stopRequested = true;
    job.running.terminate();
  }

  list(): JobReply {
    return { ok: true, exitCode: 0, digest: null, output: this.describe() ?? 'This run has no background jobs.' };
  }

  /** One line per kept job; null when there are none. */
  describe(): string | null {
    if (this.jobs.size === 0) return null;
    return ['Background jobs of this run:', ...[...this.jobs.values()].map((job) => `- ${job.id} ${this.status(job)}: ${this.shortCommand(job)}`)].join('\n');
  }

  /** Kills every running job and names them; null when none was running. */
  async stopAll(): Promise<string | null> {
    const stopped = [...this.jobs.values()].filter((job) => job.running !== null);
    for (const job of stopped) this.kill(job);
    await Promise.all(stopped.map((job) => job.ended));
    return stopped.length === 0 ? null
      : `Background jobs killed because the run ended: ${stopped.map((job) => `${job.id} (${this.shortCommand(job)})`).join('; ')}`;
  }

  /** Ends every job and refuses new ones; safe to call again, and safe to call while a wait is pending. */
  dispose(): Promise<void> {
    this.disposal ??= this.stopAll().then(() => { this.jobs.clear(); });
    return this.disposal;
  }

  private unknown(jobId: string): JobReply {
    const known = [...this.jobs.keys()].join(', ') || 'none';
    return { ok: false, reason: `no background job "${jobId}"; known jobs: ${known}. Only the last ${RESULTS_KEPT} finished results are kept.` };
  }

  private shortCommand(job: Job): string {
    return job.command.length <= LISTED_COMMAND_CHARS ? job.command : `${job.command.slice(0, LISTED_COMMAND_CHARS)}…`;
  }

  private status(job: Job): string {
    return job.outcome === null ? `running for ${formatSeconds(Date.now() - job.startedAtMs)}`
      : `${job.outcome.label} after ${formatSeconds(job.outcome.elapsedMs)}`;
  }

  /** The status line comes last: a long result keeps its tail. */
  private report(job: Job): JobReply {
    const { outcome } = job;
    const body = outcome === null ? lastChars(job.running?.outputSoFar() ?? '', LIVE_TAIL_CHARS) : outcome.output;
    const changed = job.changedPaths.size === 0 ? [] : [`Files this run wrote while it ran: ${[...job.changedPaths].join(', ')}`];
    return {
      ok: true, exitCode: outcome?.exitCode ?? 0, digest: outcome?.digest ?? null,
      output: [body.trim() || '(no output yet)', ...changed, `[job ${job.id} ${this.status(job)}]`].join('\n'),
    };
  }
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts --process background-jobs`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/process/background-jobs.test.ts src/repo-search/engine/background-jobs.ts`
Expected: both exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 5: The job tool, run background=true, and how a run ends

`run` gains `background`; `job` (wait, output, stop, list) comes with `run` for a run that owns jobs. The loop refuses the first finish while a job runs, and kills jobs before the submission gate and before a forced answer. Compaction appends the job list.

These files change together because the tool unions and the prompt options are exhaustive: half of them does not compile.

Two easy mistakes: `hasExactToolSurface` must ignore `job`, or a repo-agent silently gets the restricted prompt; and `run_check` and `run` reviews must show `background=true` and `timeoutMs`, which is why command rendering includes them.

**Files:**
- `tests/process/background-job-tool.test.ts`
- `tests/repo-tool-arguments.test.ts`
- `tests/repo-search-prompts.test.ts`
- `tests/engine-prompt-preparer.test.ts`
- `tests/repo-search-orchestrator-tools.test.ts`
- `tests/live-repo-agent-compaction-replay.test.ts`
- `tests/helpers/tool-action-processor.ts`
- `src/repo-search/repo-tool-arguments.ts`
- `src/planner-protocol/repo-search.ts`
- `src/repo-search/planner-protocol.ts`
- `src/repo-search/tool-activity.ts`
- `src/repo-search/approval-review-policy.ts`
- `src/repo-search/engine/approval-gate.ts`
- `src/repo-search/prompts.ts`
- `src/repo-search/run-system-prompt.ts`
- `src/repo-search/types.ts`
- `src/repo-search/execute.ts`
- `src/repo-search/engine.ts`
- `src/repo-search/engine/task-loop-support.ts`
- `src/repo-search/engine/task-loop.ts`
- `src/repo-search/engine/prompt-preparer.ts`
- `src/repo-search/engine/tool-action-processor.ts`
- `src/orchestrator/run.ts`
- `src/status-server/chat-prompt-context.ts`

- [ ] **Step 1: Write the tests**

Create `tests/process/background-job-tool.test.ts`:

````ts
import { IsolatedRuntime } from '../helpers/isolated-runtime.ts';
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../../src/repo-search/execute.ts';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../src/planner-protocol/repo-search.ts';
import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import { BackgroundJobs, BackgroundJobSlots } from '../../src/repo-search/engine/background-jobs.ts';
import type { SubmissionGate } from '../../src/repo-search/engine/submission-gate.ts';
import { mockSiftConfig } from '../helpers/mock-config.ts';
import { DEAD_BASE_URL, DeadEndpointEnv } from '../helpers/dead-endpoints.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';
import { repoAgentFinishResponses } from '../helpers/repo-agent-mock-responses.ts';

const isolatedRuntime = new IsolatedRuntime();
const deadEndpoints = new DeadEndpointEnv();
before(() => { isolatedRuntime.start(); deadEndpoints.apply(); });
after(async () => { await isolatedRuntime.close(); deadEndpoints.restore(); });

const CONFIG = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: DEAD_BASE_URL, NumCtx: 32000 }] } } });
const call = (name: string, args: Record<string, string | number | boolean>): MockPlannerResponseInput => ({ toolCalls: [{ name, arguments: args }] });

async function runAgent(t: TestContext, mockResponses: MockPlannerResponseInput[], options: { jobs?: BackgroundJobs; submissionGate?: SubmissionGate; maxTurns?: number } = {}) {
  const slots = new BackgroundJobSlots();
  const jobs = options.jobs ?? new BackgroundJobs(slots);
  t.after(() => jobs.dispose());
  const result = await executeRepoSearchRequest({
    presetId: 'repo-search', taskKind: 'repo-agent', prompt: 'use a background job', repoRoot: createManagedTempDir('siftkit-job-tool-'),
    config: CONFIG, maxTurns: options.maxTurns ?? 12, allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES], availableModels: ['mock'],
    mockResponses, mockCommandResults: {}, backgroundJobs: jobs, submissionGate: options.submissionGate,
  });
  const task = result.scorecard.tasks[0];
  assert.ok(task);
  return { task, jobs, slots, outputs: task.commands.map((command) => command.output), slotsInUse: slots.inUse };
}

test('an agent starts a job, keeps working, and reads its result', async (t) => {
  const { task, outputs } = await runAgent(t, [
    call('run', { command: "node -e 'console.log(123)'; exit 2", background: true }),
    call('write', { path: 'note.txt', content: 'during\n' }),
    call('job', { action: 'wait', jobId: 'j1', waitMs: 30_000 }),
    call('job', { action: 'wait', jobId: 'j1', waitMs: 30_000 }),
    ...repoAgentFinishResponses('done'),
  ]);
  assert.match(outputs[0] ?? '', /Started background job j1 \(limit 1800 s\)/u);
  assert.match(outputs[2] ?? '', /^123\n(?:Files this run wrote while it ran: note\.txt\n)?\[job j1 exited 2 after \d+ s\]/u);
  assert.match(outputs[3] ?? '', /^123\n[^]*\[job j1 exited 2/u, 'an identical wait is answered, not refused as a duplicate');
  assert.equal(task.commands[2]?.exitCode, 2);
  assert.equal(task.finalOutput, 'done');
  assert.ok(task.commands.every((command) => command.safe));
});

test('a first finish with a running job is refused; a second kills it, says so, and only then reaches the checks', async (t) => {
  const jobs = new BackgroundJobs(new BackgroundJobSlots());
  const runningAtReview: number[] = [];
  const submissionGate: SubmissionGate = {
    review(answer) {
      runningAtReview.push(jobs.running().length);
      return Promise.resolve({ kind: 'accept', output: answer });
    },
  };
  const { task } = await runAgent(t, [
    call('run', { command: 'Start-Sleep 60', background: true }),
    { content: 'first try' },
    { content: 'second try' },
  ], { jobs, submissionGate });
  assert.equal(task.reason, 'finish');
  assert.match(task.finalOutput, /^second try\n\nBackground jobs killed because the run ended: j1 \(Start-Sleep 60\)$/u);
  assert.deepEqual(runningAtReview, [0]);
});

test('reaching the turn limit kills running jobs before the answer is written', async (t) => {
  const { task, jobs } = await runAgent(t, [
    call('run', { command: 'Start-Sleep 60', background: true }),
    call('job', { action: 'list' }),
    ...repoAgentFinishResponses('best effort'),
    ...repoAgentFinishResponses('best effort'),
    ...repoAgentFinishResponses('best effort'),
  ], { maxTurns: 2 });
  assert.match(task.finalOutput, /Background jobs killed because the run ended/u);
  assert.equal(jobs.running().length, 0);
});

test('bad job calls are answered with what to do', async (t) => {
  const { outputs } = await runAgent(t, [
    call('job', { action: 'output', jobId: 'j9' }),
    call('run', { command: 'node --version', background: true, outputMode: 'full' }),
    call('run', { command: 'node --version', timeoutMs: 700_000 }),
    ...repoAgentFinishResponses('done'),
  ]);
  assert.match(outputs[0] ?? '', /no background job "j9"; known jobs: none/u);
  assert.match(outputs[1] ?? '', /outputMode does not apply to a background run/u);
  assert.match(outputs[2] ?? '', /timeoutMs is at most 600000 unless background is true/u);
});
````

Modify `tests/repo-tool-arguments.test.ts`:

````diff
@@ -1,7 +1,7 @@
 import test from 'node:test';
 import assert from 'node:assert/strict';
 
-import { MAX_RUN_TIMEOUT_MS } from '../src/lib/powershell.ts';
+import { MAX_BACKGROUND_TIMEOUT_MS, MAX_JOB_WAIT_MS, MAX_RUN_TIMEOUT_MS } from '../src/lib/powershell.ts';
 import { JsonObjectSchema } from '../src/lib/json-types.ts';
 import { z } from '../src/lib/zod.ts';
 import {
@@ -186,6 +186,20 @@ test('canonical schema preserves write and edit payloads verbatim', () => {
   );
 });
 
+test('background runs get the longer time limit, and every job action parses', () => {
+  for (const call of [
+    { toolName: 'run', args: { command: 'npm test', background: true } },
+    { toolName: 'run', args: { command: 'npm test', background: true, timeoutMs: MAX_BACKGROUND_TIMEOUT_MS } },
+    { toolName: 'job', args: { action: 'wait', jobId: 'j1' } },
+    { toolName: 'job', args: { action: 'wait', jobId: 'j1', waitMs: MAX_JOB_WAIT_MS } },
+    { toolName: 'job', args: { action: 'output', jobId: 'j1' } },
+    { toolName: 'job', args: { action: 'stop', jobId: 'j1' } },
+    { toolName: 'job', args: { action: 'list' } },
+  ]) {
+    assert.equal(RepoNativeToolCallSchema.safeParse(call).success, true, JSON.stringify(call));
+  }
+});
+
 test('canonical schema rejects malformed native arguments at the model boundary', () => {
   const calls = [
     { toolName: 'read', args: {} },
@@ -201,6 +215,13 @@ test('canonical schema rejects malformed native arguments at the model boundary'
     { toolName: 'run', args: { command: 'npm test', timeoutMs: 0 } },
     { toolName: 'run', args: { command: 'npm test', timeoutMs: MAX_RUN_TIMEOUT_MS + 1 } },
     { toolName: 'run', args: { command: 'npm test', outputMode: 'verbose' } },
+    { toolName: 'run', args: { command: 'npm test', background: true, outputMode: 'full' } },
+    { toolName: 'run', args: { command: 'npm test', background: true, timeoutMs: MAX_BACKGROUND_TIMEOUT_MS + 1 } },
+    { toolName: 'run', args: { command: 'npm test', background: false, timeoutMs: MAX_RUN_TIMEOUT_MS + 1 } },
+    { toolName: 'job', args: { action: 'wait' } },
+    { toolName: 'job', args: { action: 'wait', jobId: 'j1', waitMs: MAX_JOB_WAIT_MS + 1 } },
+    { toolName: 'job', args: { action: 'list', jobId: 'j1' } },
+    { toolName: 'job', args: { action: 'restart', jobId: 'j1' } },
     { toolName: 'web_search', args: { query: 'x', timeFilter: 'decade' } },
     { toolName: 'web_fetch', args: { url: '   ' } },
     { toolName: 'unknown', args: {} },
````

Modify `tests/repo-search-prompts.test.ts`:

````diff
@@ -427,7 +427,7 @@ test('restricted repo-search planner prompt prefers structured tools over run',
 test('web chat tools ride on top of the full agent surface without restricting the prompt', () => {
   withTempRepo((repoRoot) => {
     const base = { promptPrefix: '', systemContext: buildTestContext(repoRoot), allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
-      webSearch: usableWebSearchConfig(), webToolsEnabled: true, visionEnabled: false, promptKind: 'repo-agent' as const };
+      webSearch: usableWebSearchConfig(), webToolsEnabled: true, visionEnabled: false, backgroundJobs: false, promptKind: 'repo-agent' as const };
     const web = resolveRunSystemPrompt({ ...base, webChatTools: true, orchestratorTools: false });
     const cli = resolveRunSystemPrompt({ ...base, webChatTools: false, orchestratorTools: false });
     assert.deepEqual(web.toolDefinitions.map((tool) => tool.function.name).slice(-2), ['ask_user', 'show_image']);
@@ -439,7 +439,7 @@ test('web chat tools ride on top of the full agent surface without restricting t
 
 test('every web run kind gets the web chat tools and one shared guidance block; other runs get neither', () => {
   withTempRepo((repoRoot) => {
-    const base = { promptPrefix: '', systemContext: buildTestContext(repoRoot), webSearch: usableWebSearchConfig(), webToolsEnabled: false, visionEnabled: false };
+    const base = { promptPrefix: '', systemContext: buildTestContext(repoRoot), webSearch: usableWebSearchConfig(), webToolsEnabled: false, visionEnabled: false, backgroundJobs: false };
     const kinds = [
       { ...base, promptKind: 'repo-agent' as const, allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES] },
       { ...base, promptKind: 'planner' as const, allowedTools: ['read', 'grep'] },
@@ -456,3 +456,21 @@ test('every web run kind gets the web chat tools and one shared guidance block;
     }
   });
 });
+
+test('only a run that owns background jobs is offered job and told how to use it, and keeps the full agent prompt', () => {
+  const resolve = (backgroundJobs: boolean, allowedTools: readonly string[]) => resolveRunSystemPrompt({
+    promptKind: 'repo-agent', allowedTools, promptPrefix: '', systemContext: buildTestContext(process.cwd()), webSearch: usableWebSearchConfig(),
+    webToolsEnabled: false, visionEnabled: false, webChatTools: false, backgroundJobs, orchestratorTools: false,
+  });
+  const names = (tools: ReturnType<typeof resolve>['toolDefinitions']): string[] => tools.map((tool) => tool.function.name);
+  const withJobs = resolve(true, INTERACTIVE_REPO_TOOL_NAMES);
+  const without = resolve(false, INTERACTIVE_REPO_TOOL_NAMES);
+  assert.ok(names(withJobs.toolDefinitions).includes('job'));
+  assert.match(withJobs.systemPrompt, /Background commands: start a command that takes minutes with `run`/u);
+  const missing = without.systemPrompt.split('\n').filter((line) => !withJobs.systemPrompt.includes(line.replace(/run\.$/u, 'run, job.')));
+  assert.deepEqual(missing, [], 'job adds guidance and takes nothing away');
+  assert.equal(names(without.toolDefinitions).includes('job'), false);
+  assert.doesNotMatch(without.systemPrompt, /Background commands/u);
+  assert.equal(names(resolve(true, ['read', 'grep']).toolDefinitions).includes('job'), false, 'job needs run');
+  assert.match(buildAgentSystemPrompt(buildTestContext(process.cwd())), /Everything a command leaves running is killed when the command ends/u);
+});
````

Modify `tests/engine-prompt-preparer.test.ts`:

````diff
@@ -16,6 +16,7 @@ import type { JsonSerializable } from '../src/lib/json-types.ts';
 import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
 import { mockOfflineSiftConfig } from './helpers/mock-config.ts';
 import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';
+import { BackgroundJobs, BackgroundJobSlots } from '../src/repo-search/engine/background-jobs.ts';
 import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
 import type { RepoSearchTaskKind } from '../src/repo-search/task-kind.ts';
 import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.ts';
@@ -33,6 +34,7 @@ function makePreparer(
   events: Array<Record<string, JsonSerializable>> = [],
   thinking: typeof NO_THINKING = NO_THINKING,
   taskKind: RepoSearchTaskKind = 'repo-search',
+  backgroundJobs: BackgroundJobs | null = null,
 ): PromptPreparer {
   const config = mockOfflineSiftConfig();
   const plannerTools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions());
@@ -73,6 +75,7 @@ function makePreparer(
     }),
     logger,
     timingRecorder: null,
+    backgroundJobs,
   });
 }
 
@@ -181,6 +184,28 @@ test('prepareTurn compacts an overflowing transcript to system, summary, latest
   assert.equal(Number(applied.summarizerElapsedMs) >= 0, true);
 });
 
+class ListedJobs extends BackgroundJobs {
+  override describe(): string {
+    return 'Background jobs of this run:\n- j1 running for 60 s: npm test';
+  }
+}
+
+test('compaction ends with the jobs of the run; without jobs it adds nothing', async () => {
+  for (const [jobs, roles] of [
+    [new ListedJobs(new BackgroundJobSlots()), ['system', 'assistant', 'user', 'user']],
+    [new BackgroundJobs(new BackgroundJobSlots()), ['system', 'assistant', 'user']],
+  ] as const) {
+    const transcript = makeCompactableTranscript();
+    const preparer = makePreparer(
+      new TurnBudget({ compactionReserveTokens: PROMPT_COMPACTION_RESERVE_TOKENS, totalContextTokens: 9_000, maxTurns: 45 }),
+      transcript, [{ content: 'SUMMARY BODY' }], [], NO_THINKING, 'repo-agent', jobs,
+    );
+    withKind(await prepareTurn(preparer, 1, 0), 'ready');
+    assert.deepEqual(transcript.getMessages().map((message) => message.role), roles);
+    assert.equal(transcript.render(false).includes('- j1 running for 60 s: npm test'), roles.length === 4);
+  }
+});
+
 test('prepareTurn returns a context_overflow outcome for an overflowing repo-search transcript', async () => {
   const transcript = makeCompactableTranscript();
   const events: Array<Record<string, JsonSerializable>> = [];
````

Modify `tests/repo-search-orchestrator-tools.test.ts`:

````diff
@@ -151,7 +151,7 @@ test('an orchestrator with no plan past three quarters of its context may only s
 test('only a run with a host is offered the orchestrator tools', () => {
   const base = {
     promptPrefix: '', systemContext: createEmptyPresetSystemContext(), webSearch: mockOfflineSiftConfig().WebSearch,
-    webToolsEnabled: false, visionEnabled: false, webChatTools: false, allowedTools: ['read'], promptKind: 'orchestrator' as const,
+    webToolsEnabled: false, visionEnabled: false, webChatTools: false, backgroundJobs: false, allowedTools: ['read'], promptKind: 'orchestrator' as const,
   };
   const names = (orchestratorTools: boolean) => resolveRunSystemPrompt({ ...base, orchestratorTools }).toolDefinitions
     .map((definition) => definition.function.name);
````

Modify `tests/live-repo-agent-compaction-replay.test.ts`:

````diff
@@ -284,6 +284,7 @@ test('approximate historical replay compacts the failed repo-agent turn and resu
     }),
     logger,
     timingRecorder: null,
+    backgroundJobs: null,
   });
 
   const prepared = await preparer.prepareTurn(REPLAY_TURN, 0, {
````

Modify `tests/helpers/tool-action-processor.ts`:

````diff
@@ -13,6 +13,7 @@ import type { ApprovalRequester } from '../../src/repo-search/engine/approval-ga
 import type { ChatRunEvidenceRecorder } from '../../src/repo-search/engine/chat-run-evidence.ts';
 import type { QuestionGate } from '../../src/repo-search/engine/question-gate.ts';
 import type { OrchestratorToolHost } from '../../src/repo-search/engine/orchestrator-tool-host.ts';
+import type { BackgroundJobs } from '../../src/repo-search/engine/background-jobs.ts';
 import { ToolResultBudgeter } from '../../src/repo-search/engine/tool-result-budgeter.ts';
 import { ToolStatsRecorder } from '../../src/repo-search/engine/tool-stats.ts';
 import { TranscriptManager } from '../../src/repo-search/engine/transcript-manager.ts';
@@ -43,6 +44,7 @@ export function makeProcessor(
     evidenceRecorder?: ChatRunEvidenceRecorder;
     questionGate?: QuestionGate;
     orchestratorTools?: OrchestratorToolHost;
+    backgroundJobs?: BackgroundJobs;
   } = {},
 ): {
   processor: ToolActionProcessor;
@@ -86,6 +88,7 @@ export function makeProcessor(
     evidenceRecorder: options.evidenceRecorder ?? null,
     questionGate: options.questionGate ?? null,
     orchestratorTools: options.orchestratorTools ?? null,
+    backgroundJobs: options.backgroundJobs ?? null,
     runtimeProfile: new RepoSearchRuntimeProfile(taskKind),
     chatWebGroundingEnabled: false,
     chatWebGroundingPolicy: new ChatGroundingPolicy({ enabled: false }),
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts repo-tool-arguments repo-search-prompts engine-prompt-preparer`
Expected: FAIL (unknown tool `job`, unknown property `background`)

- [ ] **Step 3: Implement**

Modify `src/repo-search/repo-tool-arguments.ts`:

````diff
@@ -1,4 +1,11 @@
-import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from '../lib/powershell.ts';
+import {
+  DEFAULT_BACKGROUND_TIMEOUT_MS,
+  DEFAULT_JOB_WAIT_MS,
+  DEFAULT_RUN_TIMEOUT_MS,
+  MAX_BACKGROUND_TIMEOUT_MS,
+  MAX_JOB_WAIT_MS,
+  MAX_RUN_TIMEOUT_MS,
+} from '../lib/powershell.ts';
 import {
   CHAT_QUESTION_MAX_CHOICES,
   OrchestratorChangeApproachArgsSchema,
@@ -94,13 +101,36 @@ export const EditToolArgsSchema = z.object({
 
 export const RunToolArgsSchema = z.object({
   command: CommandSchema.describe('Command to execute'),
-  timeoutMs: PositiveIntegerSchema.max(MAX_RUN_TIMEOUT_MS)
-    .describe(`Timeout in milliseconds (optional, default ${DEFAULT_RUN_TIMEOUT_MS}, max ${MAX_RUN_TIMEOUT_MS})`)
+  timeoutMs: PositiveIntegerSchema.max(MAX_BACKGROUND_TIMEOUT_MS)
+    .describe(`Timeout in milliseconds (optional, default ${DEFAULT_RUN_TIMEOUT_MS}, max ${MAX_RUN_TIMEOUT_MS}; with background, default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS})`)
+    .optional(),
+  background: z.boolean()
+    .describe('Return at once with a job id and keep working; read the result with the job tool (default: false). Not with outputMode.')
     .optional(),
   outputMode: RunOutputModeSchema
     .describe(`Output shaping. auto (default) keeps the final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines of test/build/lint/typecheck commands, after a digest of their whole output - use it for those. full returns raw output; on such commands a first full request is served as auto, and only an immediate identical retry with full returns raw output.`)
     .optional(),
-}).strict();
+}).strict().superRefine((args, context) => {
+  if (args.background === true && args.outputMode !== undefined) {
+    context.addIssue({ code: 'custom', path: ['outputMode'], message: 'outputMode does not apply to a background run; omit it.' });
+  }
+  if (args.background !== true && args.timeoutMs !== undefined && args.timeoutMs > MAX_RUN_TIMEOUT_MS) {
+    context.addIssue({ code: 'custom', path: ['timeoutMs'], message: `timeoutMs is at most ${MAX_RUN_TIMEOUT_MS} unless background is true.` });
+  }
+});
+
+const JobIdSchema = RequiredTrimmedTextSchema.describe('The id `run` returned, such as j1');
+export const JobToolArgsSchema = z.discriminatedUnion('action', [
+  z.object({
+    action: z.literal('wait'),
+    jobId: JobIdSchema,
+    waitMs: PositiveIntegerSchema.max(MAX_JOB_WAIT_MS)
+      .describe(`Longest wait in milliseconds (optional, default ${DEFAULT_JOB_WAIT_MS}, max ${MAX_JOB_WAIT_MS}); returns as soon as the job ends`).optional(),
+  }).strict(),
+  z.object({ action: z.literal('output'), jobId: JobIdSchema }).strict(),
+  z.object({ action: z.literal('stop'), jobId: JobIdSchema }).strict(),
+  z.object({ action: z.literal('list') }).strict(),
+]);
 
 export const GitToolArgsSchema = z.discriminatedUnion('operation', [
   z.object({ operation: z.literal('status') }).strict(),
@@ -175,6 +205,7 @@ export const REPO_TOOL_ARGUMENT_SCHEMAS = {
   write: WriteToolArgsSchema,
   edit: EditToolArgsSchema,
   run: RunToolArgsSchema,
+  job: JobToolArgsSchema,
   git: GitToolArgsSchema,
   web_search: WebSearchToolArgsSchema,
   web_fetch: WebFetchToolArgsSchema,
@@ -224,6 +255,7 @@ const ORCHESTRATOR_TOOL_CALL_NAMES = new Set<string>(ORCHESTRATOR_TOOL_CALLS.map
 export const RepoNativeToolCallSchema = z.discriminatedUnion('toolName', [
   ...REPO_EXECUTABLE_TOOL_CALLS,
   z.object({ toolName: z.literal('ask_user'), args: AskUserToolArgsSchema }).strict(),
+  z.object({ toolName: z.literal('job'), args: JobToolArgsSchema }).strict(),
   ...ORCHESTRATOR_TOOL_CALLS,
 ]);
 
@@ -244,6 +276,7 @@ export type LsToolArgs = z.infer<typeof LsToolArgsSchema>;
 export type WriteToolArgs = z.infer<typeof WriteToolArgsSchema>;
 export type EditToolArgs = z.infer<typeof EditToolArgsSchema>;
 export type RunToolArgs = z.infer<typeof RunToolArgsSchema>;
+export type JobToolArgs = z.infer<typeof JobToolArgsSchema>;
 export type GitToolArgs = z.infer<typeof GitToolArgsSchema>;
 export type WebSearchToolArgs = z.infer<typeof WebSearchToolArgsSchema>;
 export type WebFetchToolArgs = z.infer<typeof WebFetchToolArgsSchema>;
````

Modify `src/planner-protocol/repo-search.ts`:

````diff
@@ -23,6 +23,9 @@ export const WEB_CHAT_TOOL_NAMES = [
   'show_image',
 ] as const;
 
+/** Offered beside `run` to a run that owns background jobs. */
+export const BACKGROUND_JOB_TOOL_NAME = 'job';
+
 /** Tools only an orchestrator parent is offered: the host executes them against its run. */
 export const ORCHESTRATOR_TOOL_NAMES = [
   'save_plan',
````

Modify `src/repo-search/planner-protocol.ts`:

````diff
@@ -128,6 +128,11 @@ const REPO_TOOL_REGISTRY: Record<string, PlannerToolDefinition> = {
     description: `Execute a shell command in the repository root. Returns stdout and stderr. ${UNFILTERED_CHECK_OUTPUT_RULE}`,
     exampleArgs: { command: 'npm test', outputMode: 'auto' },
   }),
+  job: buildRepoToolDefinition({
+    toolName: 'job',
+    description: 'Read or stop a command started by run with background true: wait for it (returns early when it ends), read its output so far, stop it, or list this run\'s jobs. Every job is killed when the run ends.',
+    exampleArgs: { action: 'wait', jobId: 'j1' },
+  }),
   git: buildRepoToolDefinition({
     toolName: 'git',
     description: 'Inspect repository state with one typed read-only operation: status, log, show, diff, blame, grep, or ls_files.',
@@ -205,7 +210,7 @@ const REGISTERED_REPO_TOOL_NAME_SET = new Set<string>(Object.keys(REPO_TOOL_REGI
  * answer and must not be rejected as a repeat. Typed Git is deliberately absent because its fixed
  * native operations cannot mutate the working tree.
  */
-const TREE_MUTATING_TOOL_NAMES = new Set<string>(['run', 'write', 'edit', 'dispatch', 'decide', 'run_check', 'change_approach']);
+const TREE_MUTATING_TOOL_NAMES = new Set<string>(['run', 'job', 'write', 'edit', 'dispatch', 'decide', 'run_check', 'change_approach']);
 
 export function normalizeToolName(toolName: string): string {
   return String(toolName || '').trim().toLowerCase();
````

Modify `src/repo-search/tool-activity.ts`:

````diff
@@ -21,6 +21,8 @@ function deriveActivityKind(call: RepoNativeToolCall): ToolActivityKind {
       return 'web_fetch';
     case 'run':
       return isValidationCommand(call.args.command) ? 'validate' : 'command';
+    case 'job':
+      return 'command';
     case 'ask_user':
       return 'ask';
     case 'show_image':
@@ -63,6 +65,7 @@ function getActivitySubject(call: RepoNativeToolCall): ToolActivitySubject {
     case 'ls':
     case 'git':
     case 'run':
+    case 'job':
     case 'web_search':
     case 'ask_user':
     case 'save_plan':
````

Modify `src/repo-search/approval-review-policy.ts`:

````diff
@@ -45,6 +45,8 @@ export const APPROVAL_REVIEW_POLICY_LINES = [
   '',
   'For run, a payload lists the repository scripts the command executes, each with its content (null when too large to show). Judge that content like an edit/write payload: approve a script that only reads or changes files inside the repository, deny one with an effect from the deny lists, and return unsure for null content.',
   '',
+  'A run with background=true keeps running while the agent works, up to the timeoutMs shown, and is killed with the run. Judge its command exactly as if it were not in the background.',
+  '',
   'Always return unsure:',
   '- package installation',
   '- normal pushes',
````

Modify `src/repo-search/engine/approval-gate.ts`:

````diff
@@ -9,7 +9,7 @@ import type { RepoSearchProgressEvent } from '../types.ts';
 import type { JsonObject } from '../../lib/json-types.ts';
 import type { ChatToolCallIdentity } from '../../state/chat-journal-schema.ts';
 import type { ChatRunEvidenceRecorder } from './chat-run-evidence.ts';
-import { WEB_CHAT_TOOL_NAMES } from '../../planner-protocol/repo-search.ts';
+import { BACKGROUND_JOB_TOOL_NAME, WEB_CHAT_TOOL_NAMES } from '../../planner-protocol/repo-search.ts';
 import { findRunScripts } from './shell-command-policy.ts';
 
 const LOGGED_COMMAND_MAX_CHARS = 100;
@@ -67,6 +67,8 @@ const APPROVAL_EXEMPT_READ_ONLY_TOOLS = new Set<string>([
   'ls',
   // Web chat tools never mutate the tree, and a question card is itself the human decision.
   ...WEB_CHAT_TOOL_NAMES,
+  // It only reads or stops a command that was approved when it started.
+  BACKGROUND_JOB_TOOL_NAME,
 ]);
 
 export function isApprovalExemptReadOnlyTool(toolName: string): boolean {
````

Modify `src/repo-search/prompts.ts`:

````diff
@@ -8,6 +8,7 @@ import { DIGEST_TOOLS } from '../output-digest/types.ts';
 import {
   EXPOSED_REPO_TOOL_NAMES,
   INTERACTIVE_REPO_TOOL_NAMES,
+  BACKGROUND_JOB_TOOL_NAME,
   WEB_CHAT_TOOL_NAMES,
 } from '../planner-protocol/repo-search.ts';
 import type { PlannerToolDefinition } from '../planner-protocol/json-schema.ts';
@@ -227,11 +228,17 @@ const WEB_CHAT_TOOL_NAME_SET = new Set<string>(WEB_CHAT_TOOL_NAMES);
 
 /** Web chat tools ride on top of any surface, so they never turn a full surface into a restricted one. */
 function hasExactToolSurface(toolNames: readonly string[], expectedToolNames: readonly string[]): boolean {
-  const actual = new Set(toolNames.filter((toolName) => !WEB_CHAT_TOOL_NAME_SET.has(toolName)));
+  const actual = new Set(toolNames.filter((toolName) => !WEB_CHAT_TOOL_NAME_SET.has(toolName) && toolName !== BACKGROUND_JOB_TOOL_NAME));
   return actual.size === expectedToolNames.length
     && expectedToolNames.every((toolName) => actual.has(toolName));
 }
 
+/** Guidance for background runs; empty for a run that is not offered the job tool. */
+export function buildBackgroundJobInstructions(toolNames: readonly string[]): string {
+  return !toolNames.includes(BACKGROUND_JOB_TOOL_NAME) ? ''
+    : 'Background commands: start a command that takes minutes with `run` and `background: true`, keep working, and read its result with `job`. Wait for it or stop it before you finish. Do not change files its check reads while it runs. A server a later command needs must be a background job.';
+}
+
 const WEB_CHAT_TOOL_GUIDANCE: Record<(typeof WEB_CHAT_TOOL_NAMES)[number], string> = {
   ask_user: '- ask_user: ask the user one question and wait for the reply. Use it only when you cannot proceed without a decision only they can make (unclear requirements, a choice between materially different options, information the repository does not hold). Never use it to confirm routine steps, to ask permission for work already requested, or to report progress. Ask one clear question; offer up to 3 short choices when the answer is one of a few options. If the user stops the run instead of answering, the run ends.',
   show_image: '- show_image: show the user one image file from the repository inline in the chat when seeing it helps them (a screenshot, plot, or diagram you are discussing). It is display-only and not added to your context.',
@@ -250,7 +257,7 @@ const STRUCTURED_REPO_TOOL_GUIDANCE =
   '- Prefer the structured repository tools over `run` for repository discovery: use `grep` for content search, `find` for filenames, `ls` for directory structure, and `read` for anchored file content. Do not use `run` for these operations when the corresponding structured tool is available.';
 
 const RUN_SHELL_GUIDANCE =
-  `- Use \`run\` only for validation or operations that available structured tools cannot express. The structured \`grep\` tool remains available; only the Unix shell command \`grep\` is unavailable inside \`run\`. \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-String, Where-Object, Get-Content). Long output reaches you as its tail. Test and type-check output SiftKit recognises (${DIGEST_TOOLS.join(', ')}) also starts with a digest of the whole output: each tool's verdict, then every failure with its file:line and message. Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available. Commands already run inside PowerShell — never wrap them in \`powershell -Command\`. Native command output, text piped to native commands, and stdin delivered through \`$input\` use UTF-8. Split captured text with -split "\`r?\`n" to handle both CRLF and LF; splitting on \`n alone leaves a trailing \`r on CRLF text, which makes $-anchored regexes fail.`;
+  `- Use \`run\` only for validation or operations that available structured tools cannot express. The structured \`grep\` tool remains available; only the Unix shell command \`grep\` is unavailable inside \`run\`. \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-String, Where-Object, Get-Content). Long output reaches you as its tail. Test and type-check output SiftKit recognises (${DIGEST_TOOLS.join(', ')}) also starts with a digest of the whole output: each tool's verdict, then every failure with its file:line and message. Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available. Commands already run inside PowerShell — never wrap them in \`powershell -Command\`. Native command output, text piped to native commands, and stdin delivered through \`$input\` use UTF-8. Everything a command leaves running is killed when the command ends. Split captured text with -split "\`r?\`n" to handle both CRLF and LF; splitting on \`n alone leaves a trailing \`r on CRLF text, which makes $-anchored regexes fail.`;
 
 function buildNativePlannerInstructions(toolNames: readonly string[]): string {
   if (toolNames.length === 0) {
````

Modify `src/repo-search/run-system-prompt.ts`:

````diff
@@ -1,5 +1,5 @@
 import type { PlannerToolDefinition } from '../planner-protocol/json-schema.ts';
-import { ORCHESTRATOR_TOOL_NAMES, WEB_CHAT_TOOL_NAMES } from '../planner-protocol/repo-search.ts';
+import { BACKGROUND_JOB_TOOL_NAME, ORCHESTRATOR_TOOL_NAMES, WEB_CHAT_TOOL_NAMES } from '../planner-protocol/repo-search.ts';
 import type { PresetSystemContext } from '../preset-system-context.ts';
 import { PresetSystemPromptComposer } from '../preset-system-prompt.ts';
 import { applyWebToolPolicy, resolveWebToolPolicy } from '../web-search/tool-policy.ts';
@@ -7,6 +7,7 @@ import type { WebSearchConfig } from '../web-search/types.ts';
 import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.ts';
 import {
   buildAgentSystemPrompt,
+  buildBackgroundJobInstructions,
   buildOrchestratorSystemPrompt,
   buildTaskSystemPrompt,
   buildWebChatToolInstructions,
@@ -22,6 +23,8 @@ type RunSystemPromptBase = {
   visionEnabled: boolean;
   /** True only for runs bound to a durable web chat. */
   webChatTools: boolean;
+  /** The run owns background jobs, so its `run` comes with `job`. */
+  backgroundJobs: boolean;
   /** An orchestrator parent is offered its own host tools on top of its repository tools. */
   orchestratorTools: boolean;
 };
@@ -46,6 +49,7 @@ export type ResolvedRunSystemPrompt = {
 export function resolveRunSystemPrompt(request: RunSystemPromptRequest): ResolvedRunSystemPrompt {
   const allowedTools = [
     ...request.allowedTools,
+    ...(request.backgroundJobs && request.allowedTools.includes('run') ? [BACKGROUND_JOB_TOOL_NAME] : []),
     ...(request.webChatTools ? WEB_CHAT_TOOL_NAMES : []),
     ...(request.orchestratorTools ? ORCHESTRATOR_TOOL_NAMES : []),
   ];
@@ -63,9 +67,9 @@ export function resolveRunSystemPrompt(request: RunSystemPromptRequest): Resolve
       : request.promptKind === 'orchestrator'
         ? buildOrchestratorSystemPrompt(toolDefinitions)
         : buildTaskSystemPrompt(request.systemContext, toolDefinitions);
-  // One shared guidance block for the web chat tools, whatever base prompt the run kind uses.
-  const webChatToolInstructions = buildWebChatToolInstructions(toolDefinitions.map(({ function: definition }) => definition.name));
-  const systemPrompt = [baseSystemPrompt, webChatToolInstructions].filter((section) => section.length > 0).join('\n\n');
+  // Shared guidance blocks for tools that ride on a surface, whatever base prompt the run kind uses.
+  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
+  const systemPrompt = [baseSystemPrompt, buildBackgroundJobInstructions(toolNames), buildWebChatToolInstructions(toolNames)].filter((section) => section.length > 0).join('\n\n');
   return {
     systemPrompt: new PresetSystemPromptComposer(request.promptPrefix, request.systemContext)
       .compose(systemPrompt, request.additionalPromptPrefix),
````

Modify `src/repo-search/types.ts`:

````diff
@@ -17,6 +17,7 @@ import type { ChatRunEvidenceRecorder } from './engine/chat-run-evidence.ts';
 import type { QuestionGate } from './engine/question-gate.ts';
 import type { SubmissionGate } from './engine/submission-gate.ts';
 import type { OrchestratorToolHost } from './engine/orchestrator-tool-host.ts';
+import type { BackgroundJobs } from './engine/background-jobs.ts';
 import type { ChatMessage } from './planner-chat-message.ts';
 import { ScorecardSchema } from './engine.ts';
 import { ContextWarningProgressEventSchema, type LockWaitProgressEvent } from '../lib/operation-stream.ts';
@@ -246,6 +247,8 @@ export type RepoSearchExecutionRequest = {
   questionGate?: QuestionGate;
   /** Code that judges each finish before the run accepts it: an orchestrator worker's checks. */
   submissionGate?: SubmissionGate;
+  /** The run's background jobs; its presence is what offers `job`. The caller that made it disposes it. */
+  backgroundJobs?: BackgroundJobs;
   /** The orchestrator run that executes its parent's own tools; its presence is what offers them. */
   orchestratorTools?: OrchestratorToolHost;
   /** A fixed system context used instead of one built from the preset: an orchestrator parent's run-start snapshot. */
````

Modify `src/repo-search/execute.ts`:

````diff
@@ -432,6 +432,7 @@ export async function executeRepoSearchRequest(
       webToolsEnabled: request.webToolsEnabled,
       visionEnabled: activeVisionPreset.VisionEnabled === true,
       webChatTools: request.questionGate !== undefined,
+      backgroundJobs: request.backgroundJobs !== undefined,
       orchestratorTools: request.orchestratorTools !== undefined,
     };
     const runPromptRequest: RunSystemPromptRequest = taskKind === 'chat'
@@ -487,6 +488,7 @@ export async function executeRepoSearchRequest(
       questionGate: request.questionGate,
       submissionGate: request.submissionGate,
       orchestratorTools: request.orchestratorTools,
+      backgroundJobs: request.backgroundJobs,
     });
     serverLogger.debug({ scope: 'rs', id: requestId, event: 'run_done', fields: '' });
     const targetFolder = scorecard?.verdict === 'pass' ? folders.successful : folders.failed;
````

Modify `src/repo-search/engine.ts`:

````diff
@@ -50,6 +50,7 @@ import type { ChatRunEvidenceRecorder } from './engine/chat-run-evidence.ts';
 import type { QuestionGate } from './engine/question-gate.ts';
 import type { SubmissionGate } from './engine/submission-gate.ts';
 import type { OrchestratorToolHost } from './engine/orchestrator-tool-host.ts';
+import type { BackgroundJobs } from './engine/background-jobs.ts';
 
 export { type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.ts';
 
@@ -176,6 +177,7 @@ export async function runRepoSearch(options: {
   questionGate?: QuestionGate;
   submissionGate?: SubmissionGate;
   orchestratorTools?: OrchestratorToolHost;
+  backgroundJobs?: BackgroundJobs;
 }): Promise<{ scorecard: Scorecard; turnRecords: TurnTokenRecord[] }> {
   throwIfAborted(options.abortSignal);
   if (options.taskPrompt === undefined) {
@@ -264,6 +266,7 @@ export async function runRepoSearch(options: {
       questionGate: options.questionGate,
       submissionGate: options.submissionGate,
       orchestratorTools: options.orchestratorTools,
+      backgroundJobs: options.backgroundJobs,
     });
     const result = await loop.run();
     tasks.push(result);
````

Modify `src/repo-search/engine/task-loop-support.ts`:

````diff
@@ -31,6 +31,7 @@ import type { ChatRunEvidenceRecorder } from './chat-run-evidence.ts';
 import type { QuestionGate } from './question-gate.ts';
 import type { SubmissionGate } from './submission-gate.ts';
 import type { OrchestratorToolHost } from './orchestrator-tool-host.ts';
+import type { BackgroundJobs } from './background-jobs.ts';
 import { InferenceThroughputSchema, type ThroughputAuditOperation } from '@siftkit/contracts';
 
 // ---------------------------------------------------------------------------
@@ -292,6 +293,8 @@ export type RunTaskLoopOptions = {
   submissionGate?: SubmissionGate;
   /** The orchestrator run executing its parent's own tools; only an orchestrator parent has one. */
   orchestratorTools?: OrchestratorToolHost;
+  /** The run's background jobs; absent wherever `job` is not offered. */
+  backgroundJobs?: BackgroundJobs;
 };
 
 function isPlannerReasoningEnabled(config: SiftConfig): boolean {
````

Modify `src/repo-search/engine/task-loop.ts`:

````diff
@@ -182,6 +182,9 @@ export class TaskLoop {
   private readonly duplicates = new DuplicateTracker();
   private readonly forcedFinish = new ForcedFinishController();
   private truncatedFinishRejected = false;
+  private runningJobFinishRejected = false;
+  /** What the run's end killed; told to whoever reads its output. */
+  private stoppedJobsNote: string | null = null;
   private readonly readWindows = new ReadWindowGovernor();
   private readonly visionEnabled: boolean;
   private readonly visionImageRetention: number;
@@ -318,6 +321,7 @@ export class TaskLoop {
           activityObserver: this.progress,
           throughputAudit: options.throughputAudit,
         }),
+      backgroundJobs: options.backgroundJobs ?? null,
       progress: this.progress,
       logger: options.logger || null,
       timingRecorder: options.timingRecorder || null,
@@ -340,6 +344,7 @@ export class TaskLoop {
       approvalGate: this.buildApprovalRequester(options),
       evidenceRecorder: options.evidenceRecorder ?? null,
       questionGate: options.questionGate ?? null,
+      backgroundJobs: options.backgroundJobs ?? null,
       orchestratorTools: options.orchestratorTools ?? null,
       runtimeProfile: options.runtimeProfile,
       chatWebGroundingEnabled: this.chatWebGroundingEnabled,
@@ -862,6 +867,16 @@ export class TaskLoop {
       });
       return 'continue';
     }
+    const running = this.options.backgroundJobs?.running() ?? [];
+    if (running.length > 0 && !this.runningJobFinishRejected && !toolBudgetSpent && !this.forcedFinish.isActive()) {
+      this.runningJobFinishRejected = true;
+      const ids = running.map((job) => job.id).join(', ');
+      this.rejectFinish(response, `Background jobs are still running (${ids}). Wait for them or stop them with the job tool, then finish. Finishing again kills them.`);
+      this.options.logger?.write({ kind: 'turn_finish_jobs_running', taskId: this.task.id, turn, jobs: ids });
+      return 'continue';
+    }
+    // Before the submission gate: its checks and its diff must see files nothing is still writing.
+    await this.stopBackgroundJobs();
     let output = action.text;
     const gate = this.options.submissionGate;
     if (gate !== undefined) {
@@ -882,7 +897,15 @@ export class TaskLoop {
     return 'stop';
   }
 
+  private async stopBackgroundJobs(): Promise<void> {
+    const note = await this.options.backgroundJobs?.stopAll() ?? null;
+    if (note === null) return;
+    this.stoppedJobsNote = note;
+    this.options.logger?.write({ kind: 'background_jobs_stopped', taskId: this.task.id, note });
+  }
+
   async buildAgentLoopResult(): Promise<TaskResult> {
+    await this.stopBackgroundJobs();
     const answerSchema = this.options.answerSchema;
     // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
     if (!String(this.finalOutput || '').trim()) {
@@ -892,6 +915,9 @@ export class TaskLoop {
       if (problem !== null) await this.repairFinalOutput(problem);
     }
 
+    // An answer with a schema must still parse, so only a prose answer carries the note.
+    if (this.stoppedJobsNote !== null && answerSchema === undefined) this.finalOutput = `${this.finalOutput}\n\n${this.stoppedJobsNote}`;
+
     this.options.logger?.write({
       kind: 'task_done', taskId: this.task.id, reason: this.counters.reason, turnsUsed: this.turnsUsed, safetyRejects: this.counters.safetyRejects,
       invalidResponses: this.counters.invalidResponses, rejectedCalls: this.counters.rejectedCalls, nonZeroExits: this.counters.nonZeroExits,
````

Modify `src/repo-search/engine/prompt-preparer.ts`:

````diff
@@ -22,6 +22,7 @@ import {
 } from './transcript-compactor.ts';
 import { TurnBudget } from './turn-budget.ts';
 import type { RepoSearchRuntimeProfile } from './runtime-profile.ts';
+import type { BackgroundJobs } from './background-jobs.ts';
 
 /** Log visibility only: a character estimate of the preserved reasoning mass, no extra tokenize round-trip. */
 function estimateReasoningTokens(config: SiftConfig, messages: readonly ChatMessage[], reasoningContentEnabled: boolean): number {
@@ -61,6 +62,7 @@ export class PromptPreparer {
       transcript: TranscriptManager;
       runtimeProfile: RepoSearchRuntimeProfile;
       compactor: TranscriptCompaction;
+      backgroundJobs: BackgroundJobs | null;
       progress: ProgressReporter;
       logger: JsonLogger | null;
       timingRecorder: TemporaryTimingRecorder | null;
@@ -77,6 +79,7 @@ export class PromptPreparer {
       transcript: TranscriptManager;
       runtimeProfile: RepoSearchRuntimeProfile;
       compactor: TranscriptCompaction;
+      backgroundJobs: BackgroundJobs | null;
       progress: ProgressReporter;
       logger: JsonLogger | null;
       timingRecorder: TemporaryTimingRecorder | null;
@@ -227,6 +230,9 @@ export class PromptPreparer {
       compactionSummary = compacted.summaryText;
       nextMockResponseIndex = compacted.nextMockResponseIndex;
       transcript.replaceWith(compacted.messages, compacted.currentTurnStartIndex);
+      // Job ids live nowhere else once the calls that started them are summarized away.
+      const jobs = this.options.backgroundJobs?.describe() ?? null;
+      if (jobs !== null) transcript.pushUser(jobs);
       writePromptCacheEpochReset(this.options.logger, {
         taskId,
         turn,
````

Modify `src/repo-search/engine/tool-action-processor.ts`:

````diff
@@ -67,15 +67,20 @@ import {
   isOrchestratorToolCall,
   isOrchestratorToolName,
   type AskUserToolArgs,
+  type JobToolArgs,
   type OrchestratorToolCall,
   type RepoExecutableToolCall,
   type RepoNativeToolCall,
+  type RunToolArgs,
 } from '../repo-tool-arguments.ts';
 import { getAbortError, throwIfAborted } from '../../lib/abort.ts';
 import { resolveToolActionIdentity } from './tool-call-identity.ts';
 import { findShellCommandProblem, findShellReadCommand } from './shell-command-policy.ts';
 import type { RepoSearchRuntimeProfile } from './runtime-profile.ts';
 import type { OrchestratorToolHost } from './orchestrator-tool-host.ts';
+import type { BackgroundJobs, JobReply } from './background-jobs.ts';
+import { buildAgentRunEnv } from '../../lib/agent-run-marker.ts';
+import { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_JOB_WAIT_MS } from '../../lib/powershell.ts';
 import { TurnCommandResultFinalizedEventSchema } from '../live-snapshot/schemas.ts';
 
 type RunOutputDecision = ReturnType<RepoSearchRuntimeProfile['beginRun']>;
@@ -166,7 +171,15 @@ const REPEAT_KINDS = {
 type RepeatKind = keyof typeof REPEAT_KINDS;
 
 // Past the edit deadline a worker may only change files; run calls that only read are refused separately.
-const EDIT_DEADLINE_TOOLS = new Set(['edit', 'write', 'run']);
+const EDIT_DEADLINE_TOOLS = new Set(['edit', 'write', 'run', 'job']);
+
+/** A job's exit code is its command's, and its tail carries the status line, so a cut keeps the end. */
+function toJobExecution(toolType: 'run' | 'job', command: string, reply: JobReply): RepoToolExecution {
+  return reply.ok
+    ? { ok: true, requestedCommand: command, command, exitCode: reply.exitCode, output: reply.output, toolType,
+      outputUnit: 'lines', outputKeep: 'tail', ...(reply.digest === null ? {} : { digest: reply.digest }) }
+    : { ok: false, command, reason: reply.reason, toolType };
+}
 
 export type ToolActionProcessorDeps = {
   task: TaskDefinition;
@@ -187,6 +200,8 @@ export type ToolActionProcessorDeps = {
   questionGate: QuestionGate | null;
   /** The orchestrator run that executes its parent's own tools; absent for every other run. */
   orchestratorTools: OrchestratorToolHost | null;
+  /** The run's background jobs; null wherever `job` is not offered. */
+  backgroundJobs: BackgroundJobs | null;
   runtimeProfile: RepoSearchRuntimeProfile;
   chatWebGroundingEnabled: boolean;
   chatWebGroundingPolicy: ChatGroundingPolicy;
@@ -828,8 +843,8 @@ export class ToolActionProcessor {
       rejected: false,
     });
     // A repeated `read` is legitimate: planRead advances past already-returned lines each time. An orchestrator
-    // tool answers from the run's current state, so repeating one is never a duplicate either.
-    const repeatsByDesign = normalizedToolName === 'read' || isOrchestratorToolName(normalizedToolName);
+    // tool or `job` answers from the run's current state, so repeating one is never a duplicate either.
+    const repeatsByDesign = normalizedToolName === 'read' || normalizedToolName === 'job' || isOrchestratorToolName(normalizedToolName);
     // A repeated `run` is legitimate exactly once: when it is the granted back-to-back "full"
     // retry of a command whose first "full" request was served as "auto".
     const canAdvanceRepeatedRun = runFullOutputDecision?.kind === 'retry';
@@ -959,9 +974,32 @@ export class ToolActionProcessor {
     const call = context.nativeCall;
     if (call.toolName === 'ask_user') return this.askUser(turn, state, context.progressToolCallId, call.args, context.command);
     if (isOrchestratorToolCall(call)) return this.runOrchestratorTool(call, context.command);
+    if (call.toolName === 'job') return this.answerJob(call.args, context.command);
+    if (call.toolName === 'run' && call.args.background === true) return this.startJob(call.args, context.command);
     return this.runNativeExecution(call, context.command, context.runFullOutputDecision);
   }
 
+  private startJob(args: RunToolArgs, command: string): RepoToolExecution {
+    const jobs = this.deps.backgroundJobs;
+    if (jobs === null) return { ok: false, command, reason: 'this run has no background jobs; run the command in the foreground', toolType: 'run' };
+    return toJobExecution('run', command, jobs.start({
+      command: args.command, cwd: this.deps.repoRoot, timeoutMs: args.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
+      env: buildAgentRunEnv(this.deps.task.id, this.deps.agentServerUrl),
+    }));
+  }
+
+  private async answerJob(args: JobToolArgs, command: string): Promise<RepoToolExecution> {
+    const jobs = this.deps.backgroundJobs;
+    // job is offered only to runs given background jobs.
+    if (jobs === null) throw new Error('job reached a run without background jobs.');
+    switch (args.action) {
+      case 'wait': return toJobExecution('job', command, await jobs.wait(args.jobId, args.waitMs ?? DEFAULT_JOB_WAIT_MS, this.deps.abortSignal));
+      case 'output': return toJobExecution('job', command, jobs.output(args.jobId));
+      case 'stop': return toJobExecution('job', command, await jobs.stop(args.jobId));
+      case 'list': return toJobExecution('job', command, jobs.list());
+    }
+  }
+
   /** The host's answer is the tool result; orchestrator tools are offered only to runs given a host. */
   private async runOrchestratorTool(call: OrchestratorToolCall, command: string): Promise<RepoToolExecution> {
     const host = this.deps.orchestratorTools;
@@ -1461,7 +1499,7 @@ export class ToolActionProcessor {
       this.deps.duplicates.forgetSuccesses();
     }
     // Commands and children can rewrite any file, so every earlier read is stale.
-    if (normalizedToolName === 'run' || normalizedToolName === 'run_check' || normalizedToolName === 'dispatch' || normalizedToolName === 'decide'
+    if (normalizedToolName === 'run' || normalizedToolName === 'job' || normalizedToolName === 'run_check' || normalizedToolName === 'dispatch' || normalizedToolName === 'decide'
       || normalizedToolName === 'change_approach') {
       this.deps.readWindows.invalidateAll();
       return;
@@ -1469,6 +1507,7 @@ export class ToolActionProcessor {
     if (commandSucceeded && nativeExecution && nativeExecution.ok && nativeExecution.mutatedPath) {
       this.deps.readWindows.invalidatePath(buildReadPathKey(nativeExecution.mutatedPath));
       this.deps.mutatedPaths.add(nativeExecution.mutatedPath);
+      this.deps.backgroundJobs?.noteChangedPath(nativeExecution.mutatedPath);
     }
   }
 }
````

Modify `src/orchestrator/run.ts`:

````diff
@@ -323,7 +323,7 @@ export class OrchestratorRun implements OrchestratorLiveRun, OrchestratorToolHos
     const allowedTools = [...preset.allowedTools];
     this.activity.startParent({ user: prompt, system: resolveRunSystemPrompt({
       promptKind: 'orchestrator', allowedTools, promptPrefix: preset.promptPrefix, systemContext,
-      webSearch: this.lease.config.WebSearch, webToolsEnabled: undefined, webChatTools: false, orchestratorTools: true,
+      webSearch: this.lease.config.WebSearch, webToolsEnabled: undefined, webChatTools: false, backgroundJobs: false, orchestratorTools: true,
       visionEnabled: getActiveModelPreset(this.lease.config).VisionEnabled === true,
     }).systemPrompt }, getConfiguredContextTokens(this.lease.config).totalContextTokens);
     const result = await this.ctx.engineService.executeRepoSearch({
````

Modify `src/status-server/chat-prompt-context.ts`:

````diff
@@ -42,8 +42,10 @@ export function buildChatPromptContext(config: SiftConfig, session: ChatSession)
   // Resolved like the next run's admission would be, so the preview shows the model it would use.
   const effectiveConfig = resolveChatPreviewConfig(config, session);
   // Every path goes through the resolver the engine itself calls, so this panel cannot drift from the run.
+  const surface = resolvePromptSurface(effectiveConfig, session, preset);
   const { systemPrompt, toolDefinitions } = resolveRunSystemPrompt({
-    ...resolvePromptSurface(effectiveConfig, session, preset),
+    ...surface,
+    backgroundJobs: surface.promptKind === 'repo-agent',
     promptPrefix: preset.promptPrefix,
     systemContext: new PresetSystemContextBuilder(session.planRepoRoot).build(preset),
     webSearch: effectiveConfig.WebSearch,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts repo-tool-arguments repo-search-prompts engine-prompt-preparer repo-search-orchestrator-tools tool-action-processor`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/process/background-job-tool.test.ts tests/repo-tool-arguments.test.ts tests/repo-search-prompts.test.ts tests/engine-prompt-preparer.test.ts tests/repo-search-orchestrator-tools.test.ts tests/live-repo-agent-compaction-replay.test.ts tests/helpers/tool-action-processor.ts src/repo-search/repo-tool-arguments.ts src/planner-protocol/repo-search.ts src/repo-search/planner-protocol.ts src/repo-search/tool-activity.ts src/repo-search/approval-review-policy.ts src/repo-search/engine/approval-gate.ts src/repo-search/prompts.ts src/repo-search/run-system-prompt.ts src/repo-search/types.ts src/repo-search/execute.ts src/repo-search/engine.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/tool-action-processor.ts src/orchestrator/run.ts src/status-server/chat-prompt-context.ts`
Expected: both exit 0 with no output.

Run: `node .\src\test-runner\run-tests.ts --process background-job-tool`
Expected: 4 tests pass.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 6: A run owns its jobs and never outlives them

Only a repo-agent run gets jobs. They are disposed before its outcome is published, before its lock and repository are released, and at server shutdown.

**Files:**
- `tests/process/repo-agent-session-jobs.test.ts`
- `src/status-server/repo-agent-sessions.ts`
- `src/status-server/index.ts`

- [ ] **Step 1: Write the tests**

Create `tests/process/repo-agent-session-jobs.test.ts`:

````ts
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getDefaultConfigObject } from '../../src/config/defaults.ts';
import { getAbortError } from '../../src/lib/abort.ts';
import { RepoAgentRunRequestSchema } from '../../src/repo-agent/run-schemas.ts';
import { RepoAgentRunStore } from '../../src/repo-agent/run-store.ts';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../../src/repo-search/types.ts';
import { parseRepoSearchRequest } from '../../src/status-server/route-request-normalizers.ts';
import { createRepoSearchAdmissionRecord } from '../../src/status-server/repo-search-admissions.ts';
import { RepositoryGate } from '../../src/status-server/orchestrator-runs.ts';
import { RepoAgentSessionManager, type RepoAgentEngine, type RepoAgentModelLockAdapter, type RepoAgentModelLockHandle, type RepoAgentSession } from '../../src/status-server/repo-agent-sessions.ts';
import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.ts';
import { buildMockScorecard } from '../_test-helpers.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';
import { currentModelTarget } from '../helpers/chat-run-recorder.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

type Ending = 'finish' | 'failure' | 'abort' | 'approval denied' | 'approval timeout' | 'shutdown';

/** Starts one job that leaves two processes behind, then ends the run the way the test asks. */
class JobEngine implements RepoAgentEngine {
  private readonly ending: Ending;
  private readonly marker: string;
  /** Resolves once the job and the processes it leaves are running. */
  readonly jobRunning: Promise<void>;
  private markRunning: () => void = () => undefined;

  constructor(ending: Ending, marker: string) {
    this.ending = ending;
    this.marker = marker;
    this.jobRunning = new Promise((resolve) => { this.markRunning = resolve; });
  }

  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const jobs = request.backgroundJobs;
    assert.ok(jobs);
    assert.equal(jobs.start({ command: `${leaveProcessesCommand(this.marker)}; Start-Sleep 120`, cwd: request.repoRoot, timeoutMs: 120_000, env: {} }).ok, true);
    while (countMarkedProcesses(this.marker) < 2) await delay(100);
    this.markRunning();
    if (this.ending === 'failure') throw new Error('engine exploded');
    if (this.ending === 'abort') {
      await new Promise((_resolve, reject) => { request.abortSignal?.addEventListener('abort', () => { reject(getAbortError(request.abortSignal)); }, { once: true }); });
    }
    if (this.ending === 'approval denied' || this.ending === 'approval timeout') {
      const decision = await request.approvalGate?.request({ turn: 1, toolName: 'run', command: 'npm test', reviewPayload: null });
      if (decision?.kind === 'abort') throw new Error(decision.reason);
    }
    if (this.ending === 'shutdown') while (jobs.running().length > 0) await delay(50);
    const scorecard = buildMockScorecard('done');
    const task = scorecard.tasks[0];
    assert.ok(task);
    task.reason = 'finish';
    return { requestId: 'r', transcriptPath: 'db://t', artifactPath: 'db://a', scorecard, turnRecords: [] };
  }
}

const LOCKS: RepoAgentModelLockAdapter = {
  acquire: (): Promise<RepoAgentModelLockHandle | null> => Promise.resolve({
    context: currentModelTarget(getDefaultConfigObject()), release: () => undefined, renewActivity: () => undefined,
  }),
  queueLength: () => 0,
};

function startSession(t: TestContext, ending: Ending, marker: string): { manager: RepoAgentSessionManager; session: RepoAgentSession; engine: JobEngine; gate: RepositoryGate; root: string } {
  const root = createManagedTempDir('siftkit-session-jobs-');
  const previousCwd = process.cwd();
  process.chdir(root);
  t.after(() => { closeAllRuntimeDatabases(); process.chdir(previousCwd); });
  const store = new RepoAgentRunStore(path.join(root, 'runs'));
  const engine = new JobEngine(ending, marker);
  const gate = new RepositoryGate();
  const manager = new RepoAgentSessionManager({ store, engine });
  const runId = randomUUID();
  store.create(RepoAgentRunRequestSchema.parse({ runId, task: 'jobs', repoRoot: root, approval: 'interactive' }));
  const routeRequest = parseRepoSearchRequest({ prompt: 'jobs', repoRoot: root });
  assert.ok(routeRequest);
  const admission = createRepoSearchAdmissionRecord(routeRequest, getDefaultConfigObject());
  const session = manager.start({
    runId, requestId: admission.requestId, admission, approvalMode: 'interactive', approvalDelivery: 'boundary', locks: LOCKS, repository: { gate, repoRoot: root, access: 'exclusive' }, approvalGates: new Map(),
    ...(ending === 'approval timeout' ? { decisionTimeoutMs: 500 } : {}),
    engineRequest: { presetId: 'repo-agent', taskKind: 'repo-agent', prompt: 'jobs', repoRoot: root, allowedTools: ['run'] },
  });
  return { manager, session, engine, gate, root };
}

const EXPECTED_STATUS: Record<Ending, string> = {
  finish: 'completed', failure: 'failed', abort: 'aborted', 'approval denied': 'completed', 'approval timeout': 'approval_timeout', shutdown: 'completed',
};

for (const ending of ['finish', 'failure', 'abort', 'approval denied', 'approval timeout', 'shutdown'] as const) {
  test(`no job outlives its run: ${ending}`, async (t) => {
    const marker = agentProcessMarker();
    t.after(() => { killMarkedProcesses(marker); });
    const { manager, session, engine, gate, root } = startSession(t, ending, marker);
    await engine.jobRunning;
    if (ending === 'abort') session.abort();
    if (ending === 'shutdown') await manager.disposeBackgroundJobs();
    if (ending === 'approval denied') {
      await session.waitForBoundary(1);
      session.submitDecision({ runId: session.runId, decision: 'deny', reason: 'no' });
    }
    // The next run gets the repository the moment this one lets go of it.
    const next = await gate.acquire(root, 'exclusive', new AbortController().signal);
    assert.equal(countMarkedProcesses(marker), 0, 'every process was gone before the repository came back');
    next.release();
    await session.settled;
    assert.equal(session.getState().status, EXPECTED_STATUS[ending]);
  });
}
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts --process repo-agent-session-jobs`
Expected: FAIL (`request.backgroundJobs` is undefined, and `disposeBackgroundJobs` does not exist)

- [ ] **Step 3: Implement**

Modify `src/status-server/repo-agent-sessions.ts`:

````diff
@@ -1,5 +1,6 @@
 import { toError } from '../lib/errors.ts';
 import { getConfiguredEngineNumCtx } from '../config/getters.ts';
+import type { SiftConfig } from '../config/types.ts';
 import { getAbortError } from '../lib/abort.ts';
 import { ProgressWriter } from '../lib/progress-writer.ts';
 import { classifyRepoAgentExecutionResult } from '../repo-agent/run-output.ts';
@@ -21,6 +22,7 @@ import {
   type ApprovalGateObserver,
   type ApprovalParkLease,
 } from '../repo-search/engine/approval-gate.ts';
+import { BackgroundJobs, BackgroundJobSlots } from '../repo-search/engine/background-jobs.ts';
 import { RepoSearchResponseSanityChecker } from '../repo-search/response-sanity.ts';
 import type {
   ApprovalRequestProgressEvent,
@@ -76,7 +78,7 @@ export type RepoAgentModelLockAdapter = {
 /** The model snapshot fields are absent: the session takes them from its admitted lock. */
 export type RepoAgentEngineRequest = Omit<
   RepoSearchExecutionRequest,
-  'progressWriter' | 'approvalGate' | 'abortSignal' | 'config'
+  'progressWriter' | 'approvalGate' | 'abortSignal' | 'config' | 'backgroundJobs'
 >;
 
 /** Where a parked approval surfaces: as a progress frame to the attached client, or as a boundary result. */
@@ -129,6 +131,8 @@ export type RepoAgentSessionOptions = {
   /** Held for the whole run, taken before the model; null when the caller already owns the repository. */
   repository: { gate: RepositoryGate; repoRoot: string; access: RepositoryAccess } | null;
   approvalGates: Map<string, ApprovalGate>;
+  /** The server's background job slots, shared by every run. */
+  backgroundJobSlots: BackgroundJobSlots;
   engineRequest: RepoAgentEngineRequest;
   decisionTimeoutMs?: number;
 };
@@ -154,6 +158,8 @@ export class RepoAgentSession implements ApprovalGateObserver, ApprovalParkLease
   private readonly executionSignal: AbortSignal;
   private readonly progressWriter = new SessionProgressWriter(this);
   private readonly gate: ApprovalGate;
+  /** Only a repo-agent run may start jobs; a repo-search worker shares this session but not the tool. */
+  private readonly backgroundJobs: BackgroundJobs | null;
   private readonly waiters: BoundaryWaiter[] = [];
   private readonly subscribers = new Set<RepoAgentSessionSubscriber>();
   private lock: RepoAgentModelLockHandle | null = null;
@@ -178,6 +184,7 @@ export class RepoAgentSession implements ApprovalGateObserver, ApprovalParkLease
     this.executionSignal = options.engineRequest.evidenceRecorder?.abortSignal
       ? AbortSignal.any([this.abortController.signal, options.engineRequest.evidenceRecorder.abortSignal]) : this.abortController.signal;
     this.state = this.store.readState(this.runId);
+    this.backgroundJobs = options.engineRequest.taskKind === 'repo-agent' ? new BackgroundJobs(options.backgroundJobSlots) : null;
     this.gate = new ApprovalGate({
       evidenceRecorder: options.engineRequest.evidenceRecorder,
       requestId: options.requestId,
@@ -193,6 +200,11 @@ export class RepoAgentSession implements ApprovalGateObserver, ApprovalParkLease
     });
   }
 
+  /** Kills the run's jobs and refuses new ones; the run itself goes on. */
+  async disposeBackgroundJobs(): Promise<void> {
+    await this.backgroundJobs?.dispose();
+  }
+
   getApprovalMode(): ApprovalMode {
     return this.gate.mode;
   }
@@ -424,13 +436,7 @@ export class RepoAgentSession implements ApprovalGateObserver, ApprovalParkLease
         pid: process.pid,
       }));
       const { context } = this.lock;
-      const result = await this.engine.executeRepoSearch({
-        ...this.engineRequest,
-        config: context.config,
-        abortSignal: this.executionSignal,
-        progressWriter: this.progressWriter,
-        approvalGate: this.gate,
-      });
+      const result = await this.execute(context.config);
       RepoSearchResponseSanityChecker.assertSafeToSend(result);
       this.executionResult = result;
       if (!isTerminalStatus(this.state.status)) {
@@ -458,6 +464,22 @@ export class RepoAgentSession implements ApprovalGateObserver, ApprovalParkLease
     }
   }
 
+  /** Jobs end before the run's outcome is published, while the lock and the repository are still held. */
+  private async execute(config: SiftConfig): Promise<RepoSearchExecutionResult> {
+    try {
+      return await this.engine.executeRepoSearch({
+        ...this.engineRequest,
+        config,
+        abortSignal: this.executionSignal,
+        progressWriter: this.progressWriter,
+        approvalGate: this.gate,
+        ...(this.backgroundJobs === null ? {} : { backgroundJobs: this.backgroundJobs }),
+      });
+    } finally {
+      await this.disposeBackgroundJobs();
+    }
+  }
+
   private settleFailure(message: string): void {
     const failureMessage = normalizeFailureMessage(message);
     try {
@@ -589,17 +611,24 @@ export class RepoAgentSessionManager {
   private readonly sessions = new Map<string, RepoAgentSession>();
   private readonly store: RepoAgentRunStore;
   private readonly engine: RepoAgentEngine;
+  private readonly backgroundJobSlots = new BackgroundJobSlots();
 
   constructor(deps: { store: RepoAgentRunStore; engine: RepoAgentEngine }) {
     this.store = deps.store;
     this.engine = deps.engine;
   }
 
-  start(options: Omit<RepoAgentSessionOptions, 'store' | 'engine'>): RepoAgentSession {
+  /** Shutdown: no job outlives the server, whatever its run is doing. */
+  async disposeBackgroundJobs(): Promise<void> {
+    await Promise.all([...this.sessions.values()].map((session) => session.disposeBackgroundJobs()));
+  }
+
+  start(options: Omit<RepoAgentSessionOptions, 'store' | 'engine' | 'backgroundJobSlots'>): RepoAgentSession {
     const session = new RepoAgentSession({
       ...options,
       store: this.store,
       engine: this.engine,
+      backgroundJobSlots: this.backgroundJobSlots,
     });
     this.sessions.set(options.runId, session);
     session.start();
````

Modify `src/status-server/index.ts`:

````diff
@@ -508,6 +508,7 @@ export function startStatusServer(options: StartStatusServerOptions = {}): Exten
     closeRequested = true;
     // Stop scheduling and abort owned children first; the close handler awaits their settlement.
     void orchestratorRuns.shutdown().catch(() => {});
+    void ctx.repoAgentSessions.disposeBackgroundJobs();
     ctx.modelIdleController?.cancelForPresetChange();
     void presetRuntimeCoordinator.shutdown().catch((error) => {
       process.stderr.write(`[siftKitStatus] Failed to stop inference runtime: ${error instanceof Error ? error.message : String(error)}\n`);
@@ -571,6 +572,7 @@ export function startStatusServer(options: StartStatusServerOptions = {}): Exten
       let failure: Error | null = null;
       try {
         await orchestratorRuns.shutdown();
+        await ctx.repoAgentSessions.disposeBackgroundJobs();
         await server.waitForRequestsIdle();
         await ctx.inferenceRunFlushQueue.drainForShutdown(SHUTDOWN_PERSISTENCE_TIMEOUT_MS);
         await flushTerminalMetadataForShutdown(ctx, SHUTDOWN_PERSISTENCE_TIMEOUT_MS);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts --process repo-agent-session-jobs`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/process/repo-agent-session-jobs.test.ts src/status-server/repo-agent-sessions.ts src/status-server/index.ts`
Expected: both exit 0 with no output.

- [ ] **Step 5: Prove the test sees a leak**

Replace `await this.disposeBackgroundJobs();` in `execute()` with `await Promise.resolve();` and run the test again.
Expected: five of the six endings FAIL (shutdown disposes through the manager and still passes). Restore the line; all six pass.

Run: `node .\src\test-runner\run-tests.ts repo-agent-sessions`
Expected: pass.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 7: Refuse commands that escape any job

WMI, Task Scheduler, services and Docker start processes as children of another service. The direct forms are refused before approval. This is text matching: it catches ordinary use, not a determined script.

**Files:**
- `tests/shell-command-policy.test.ts`
- `src/repo-search/engine/shell-command-policy.ts`

- [ ] **Step 1: Write the tests**

Modify `tests/shell-command-policy.test.ts`:

````diff
@@ -140,6 +140,36 @@ test('neither the orchestrator nor a worker may start siftkit from a command', (
   }
 });
 
+test('a command that asks a service to start a process is refused; its harmless neighbours are not', () => {
+  const root = makeRoot();
+  for (const [command, named] of [
+    ["Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'ping x' }", 'Win32_Process'],
+    ["iwmi -Class win32_process -Name Create -ArgumentList 'ping x'", 'Win32_Process'],
+    ['$r = Invoke-CimMethod Win32_Process Create', 'Win32_Process'],
+    ["wmic process call create 'ping x'", 'wmic process call create'],
+    ["schtasks /create /tn t /tr 'ping x' /sc once /st 00:00", 'schtasks /create'],
+    ['cmd /c schtasks.exe /Create /tn t', 'schtasks /create'],
+    ['Register-ScheduledTask -TaskName t -Action $a', 'Register-ScheduledTask'],
+    ['New-Service -Name s -BinaryPathName x', 'New-Service'],
+    ['sc.exe create s binPath= x', 'sc create'],
+    ['docker run -d redis', 'docker run -d'],
+    ['docker run --rm -itd -p 80:80 redis', 'docker run -d'],
+    ['docker container run --detach redis', 'docker run -d'],
+    ['docker compose -f a.yml up -d', 'docker compose up -d'],
+    ['docker-compose up --detach', 'docker compose up -d'],
+  ] as const) {
+    for (const call of [run(command), { toolName: 'run_check' as const, args: { command, cwd: '.' } }]) {
+      assert.ok(findShellCommandProblem(call, root)?.startsWith(`\`${named}\` starts a process this run could not stop.`), `${call.toolName}: ${command}`);
+    }
+  }
+  for (const command of [
+    'Get-CimInstance Win32_Process', 'schtasks /query', 'wmic process list', 'sc.exe query', 'docker run --rm redis redis-cli ping',
+    'docker compose up', 'docker ps', "git log --grep 'docker run -d'",
+  ]) {
+    assert.equal(findShellCommandProblem(run(command), root), null, command);
+  }
+});
+
 test('tools other than run and run_check are not judged', () => {
   assert.equal(findShellCommandProblem({ toolName: 'read', args: { path: '..\\x.txt' } }, makeRoot()), null);
 });
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts shell-command-policy`
Expected: FAIL (the new test gets `null` for `Invoke-CimMethod ...`)

- [ ] **Step 3: Implement**

Modify `src/repo-search/engine/shell-command-policy.ts`:

````diff
@@ -181,6 +181,35 @@ function findSiftKitInvocation(command: string): string | null {
   return null;
 }
 
+/** A command that asks another service to start a process, which no job can hold or stop. */
+const ESCAPE_FORMS = [
+  { heads: ['invoke-cimmethod', 'icim', 'invoke-wmimethod', 'iwmi'], args: /\bwin32_process\b/iu, named: 'Win32_Process' },
+  { heads: ['wmic'], args: /\bprocess\s+call\s+create\b/iu, named: 'wmic process call create' },
+  { heads: ['schtasks'], args: /(?:^|\s)[/-]create\b/iu, named: 'schtasks /create' },
+  { heads: ['register-scheduledtask'], args: /^/u, named: 'Register-ScheduledTask' },
+  { heads: ['new-service'], args: /^/u, named: 'New-Service' },
+  { heads: ['sc'], args: /^create\b/iu, named: 'sc create' },
+  { heads: ['docker'], args: /^(?:container\s+)?run\b.*\s(?:-[it]*d[it]*|--detach)(?:\s|$)/iu, named: 'docker run -d' },
+  { heads: ['docker'], args: /^compose\b.*\sup\b.*\s(?:-d|--detach)(?:\s|$)/iu, named: 'docker compose up -d' },
+  { heads: ['docker-compose'], args: /^(?:.*\s)?up\b.*\s(?:-d|--detach)(?:\s|$)/iu, named: 'docker compose up -d' },
+] as const;
+
+function findEscapeForm(command: string): string | null {
+  for (const { tokens, commandStarts } of splitStatements(command)) {
+    for (const start of commandStarts) {
+      const index = commandHead(tokens, start);
+      const head = path.win32.basename(tokens[index] ?? '').toLowerCase().replace(/\.exe$/u, '');
+      const rest = tokens.slice(index + 1).join(' ');
+      for (const { heads, args, named } of ESCAPE_FORMS) {
+        if (heads.some((name) => name === head) && args.test(rest)) {
+          return `\`${named}\` starts a process this run could not stop. Run it as a normal command, or as \`run\` with background=true.`;
+        }
+      }
+    }
+  }
+  return null;
+}
+
 /**
  * A run or run_check whose every command only reads: it is refused with the tool to use instead. A variable
  * expression (`$x`, `$_`) is no command; a redirect or any other command makes the whole call real work.
@@ -240,8 +269,8 @@ export function findPathsOutsideRepo(text: string, repoRoot: string): string[] {
 }
 
 /**
- * Why a run or run_check command may not run: it reaches outside the repository root, starts SiftKit, or
- * cuts the output of a check the digest must read whole. Judged before approval, so no reviewer call is spent on it.
+ * Why a run or run_check command may not run: it reaches outside the repository root, starts SiftKit or a
+ * process the run could not stop, or cuts the output of a check the digest must read whole. Judged before approval, so no reviewer call is spent on it.
  */
 export function findShellCommandProblem(call: RepoNativeToolCall, repoRoot: string): string | null {
   if (call.toolName !== 'run' && call.toolName !== 'run_check') return null;
@@ -250,5 +279,6 @@ export function findShellCommandProblem(call: RepoNativeToolCall, repoRoot: stri
   if (cwd === null) return outsideRoot(cwdText, repoRoot);
   return findEscapingPath(call.args.command, cwd, repoRoot)
     ?? findSiftKitInvocation(call.args.command)
+    ?? findEscapeForm(call.args.command)
     ?? findCutCheckOutput(call.args.command);
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts shell-command-policy`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/shell-command-policy.test.ts src/repo-search/engine/shell-command-policy.ts`
Expected: both exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 8: Soak, review and full validation

**Files:**
- `tests/process/background-jobs-soak.test.ts`

- [ ] **Step 1: Add the opt-in soak**

Create `tests/process/background-jobs-soak.test.ts`:

````ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { z } from 'zod';

import { BackgroundJobs, BackgroundJobSlots } from '../../src/repo-search/engine/background-jobs.ts';

const JOBS = 500;
const WARMUP_JOBS = 20;
const ENABLED = process.env.SIFTKIT_TEST_JOB_SOAK === '1';

const COMMANDS = [
  'Write-Output short',
  `& '${process.execPath}' -e "const c = Buffer.alloc(1024 * 1024, 97); let n = 100; const next = () => { while (n > 0) { n -= 1; if (!process.stdout.write(c)) { process.stdout.once('drain', next); return; } } }; next();"`,
  "1..20 | ForEach-Object { Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','120','127.0.0.1' }",
];

setFlagsFromString('--expose-gc');
const collect = z.custom<() => void>((value) => typeof value === 'function').parse(runInNewContext('gc'));

function measure(): { heapMiB: number; externalMiB: number; handles: number; children: number } {
  collect();
  collect();
  const { heapUsed, external } = process.memoryUsage();
  const query = `$p = Get-Process -Id ${process.pid}; $c = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.ProcessId -ne $PID }).Count; Write-Output "$($p.HandleCount) $c"`;
  const [handles, children] = spawnSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number);
  assert.ok(handles !== undefined && children !== undefined);
  return { heapMiB: heapUsed / 2 ** 20, externalMiB: external / 2 ** 20, handles, children };
}

test('500 background jobs leave memory, handles and processes where they started', { skip: !ENABLED, timeout: 45 * 60_000 }, async () => {
  const slots = new BackgroundJobSlots();
  let baseline = measure();
  for (let index = 1; index <= JOBS; index += 1) {
    const jobs = new BackgroundJobs(slots);
    const command = COMMANDS[index % COMMANDS.length];
    assert.ok(command);
    assert.equal(jobs.start({ command, cwd: process.cwd(), timeoutMs: 120_000, env: {} }).ok, true);
    if (index % 7 === 0) await jobs.stop('j1');
    else await jobs.wait('j1', 120_000, undefined);
    await jobs.dispose();
    if (index === WARMUP_JOBS) baseline = measure();
  }
  const after = measure();
  process.stdout.write(`baseline ${JSON.stringify(baseline)} after ${JSON.stringify(after)}\n`);
  assert.equal(slots.inUse, 0);
  assert.equal(after.children, 0);
  assert.ok(after.heapMiB <= baseline.heapMiB * 1.05 + 1, 'heap grew');
  assert.ok(after.externalMiB <= baseline.externalMiB * 1.05 + 1, 'buffers grew');
  assert.ok(after.handles <= baseline.handles * 1.05 + 5, 'handles grew');
});
````

- [ ] **Step 2: Run it with nothing else running**

Run (PowerShell): `$env:SIFTKIT_TEST_JOB_SOAK='1'; node .\src\test-runner\run-tests.ts --process background-jobs-soak --test-timeout=2700000; Remove-Item Env:\SIFTKIT_TEST_JOB_SOAK`
Expected: PASS in about 5 minutes. Record the printed `baseline` and `after` lines in the report.

- [ ] **Step 3: Independent leak review**

Give a fresh reviewer (not Fable, not the implementer) the whole diff and the spec with this instruction: "Find a way for this code to leak a process or memory: a command or job that survives its run, a slot that never comes back, a timer, listener, pipe or buffer that is never released, or output that grows without limit. The escapes listed in the spec are known and excluded. For each claim give the exact sequence of events and a failing test."
Every confirmed leak becomes a failing test before it is fixed. Report the claims that were refuted too.

- [ ] **Step 4: Full validation**

Run, through `siftkit summary` per the repository rules:

| Command | Expected |
|---|---|
| `npm run typecheck` | exit 0 (it includes lint) |
| `npm run lint` | exit 0 |
| `npm test` | no failures |
| `npm run test:process` | no failures |
| `npm run test:dashboard` | no failures |

`an acknowledgement that arrives late releases the batch close() is waiting on` has a 1,000 ms limit that takes about 750 ms on this machine with or without this change. If it fails, rerun it alone before treating it as a regression.

- [ ] **Step 5: One live run**

Start the server, then a repo-agent run with the task: "Start `npm test` in the background, read README.md while it runs, wait for the result, and report pass or fail." Check that it starts job `j1`, that a `read` runs before the result arrives, that the answer states the result, and that `Get-CimInstance Win32_Process` shows no process of that run afterwards.

**Acceptance:** all four suites are green, the soak numbers are in the report, every confirmed leak has a test, and the live run left no process.

## What was measured

In the scratch copy at the base commit, on this machine, while an orchestrator run was live:

| Check | Result |
|---|---|
| Node suite | 4,774 pass; 7 fail: six read files the copy does not have, one was this plan's memory test under load, fixed since (now 160 MiB and a second collection) and passing alone |
| Process suite | 324 pass; 7 fail. Four or five are shims, RAM disk scripts and shell integration, which read files the copy does not have. The flush-queue and history-import tests pass alone |
| Every new test | Pass, including 600 MB of output, the force-killed server and all six run endings |
| Soak, 120 jobs | Heap 17.8 to 18.0 MiB, buffers 8.0 to 8.0 MiB, handles 214 to 214, children 0 to 0 |
| Peak processes in one command | Node suite 15, process suite 49. The limit of 128 stays |
| Cost per command | About 0.3 to 0.45 s for the prelude |

In the repository, after Task 8 (27B preset active, schema 98 for the suites and 99 for the live run):

| Check | Result |
|---|---|
| Suites | 4,783 node, 331 process and 732 dashboard tests pass, none fail; type-check and lint clean |
| Soak, 500 jobs, 202 s | Heap 17.8 to 18.3 MiB, buffers 8.0 to 8.0 MiB, handles 214 to 214, children 0 to 0 |
| Independent leak review (`repo-search`) | No leak found; 16 suspected leaks refuted with the line that refutes each |
| Live run | `npm test` ran as `j1` while README.md was read; 4,803 pass; no process left. The shared tree already held the second plan's Tasks 1 to 4 |

Task 5's approval-gate hunk was refused by the reviewer of `repo-agent` and applied by hand, as the spec requires (`job` needs no approval).
