# Session Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the ten directive violations introduced by the 2026-08-16 scalability refactor session (Tasks 11–15), leaving one zip implementation, one request-body reader, genuinely async archive I/O, compiler-enforced test contexts, and no invented spec claims.

**Architecture:** `src/lib/zip.ts` becomes a pure format module (constants, CRC, header codecs) with exactly one writer (`ZipFileWriter`) and one reader (`ZipFileReader`) built on it; the in-memory `ZipWriter`/`readZip` pair is deleted. `http-utils.ts` grows one body-consumption loop driven by an explicit `BodySink` interface with two implementations. `ZipFileReader` becomes genuinely async via `fs.promises`, driven by an explicit `ChunkSink` interface instead of a callback, which cascades `RestoreService.preview` to async.

**Tech Stack:** TypeScript (strict, no casts / `any` / `!`), `node:test`, `node:fs` + `fs.promises`, zod for IO schemas, esbuild test bundling via `npm run build:test`.

---

## Preconditions

The working tree currently carries **unrelated user work** that must never be staged with this plan:

- `src/repo-search/execute.ts`
- `src/status-server/dashboard-runs.ts`
- `src/status-server/operation-progress-writers.ts`
- `src/status-server/repo-agent-sessions.ts`
- `src/status-server/routes/chat.ts`
- `src/status-server/server-logger.ts`
- `tests/repo-search-preflight-log.test.ts`
- `tests/repo-search-status-server.test.ts`
- `tests/repo-search.test.ts`
- `tests/server-logger.test.ts`
- `docs/superpowers/plans/2026-08-19-git-output-fidelity.md` (untracked)

It also carries two **uncommitted test fixes from this session** that are unrelated to this plan and should be committed first so the diff stays readable:

```bash
git add tests/llm-auto-approval.test.ts tests/status-server-chat-routes.test.ts
git commit -m "fix(tests): route verdict requests by marker and complete the caption scorecard fixture"
```

Run `git status --short` before every commit in this plan and stage only the exact paths each task lists.

**Baseline to beat:** `npm run test` → 3247 tests, 3245 pass, 0 fail, 2 skipped. `npm run typecheck` → clean (it also runs `eslint .`). After any `src/` or `tests/` change you must run `npm run build:test` before `npm run test -- <filter>`, or the runner aborts with "Test artifacts are stale".

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/lib/zip.ts` | Format constants, CRC32 (seeded/incremental), header + EOCD encoders and the central-directory decoder. No writer, no reader, no `node:zlib` import. |
| `src/lib/zip-file-writer.ts` | The only zip writer. Streams to disk, uses `zip.ts` codecs. |
| `src/lib/zip-file-reader.ts` | The only zip reader. Lazy, fd-based, genuinely async, uses `zip.ts` codecs and an explicit `ChunkSink`. |
| `src/status-server/http-utils.ts` | One body-consumption loop + `BodySink` interface with `BufferBodySink` / `FileBodySink`. |
| `src/assistant/control/temp-archive.ts` | `TempArchiveBuilder implements TempArchive` — one `cleanup()` semantic. |
| `src/assistant/control/restore-service.ts` | Async preview/confirm; explicit success path. |
| `src/assistant/control/export-service.ts` | Honest doc comment; no invented §16.3 claim. |
| `tests/helpers/archive-bytes.ts` | `archiveBytes`, `archiveEntries`, `archiveUploadPath`, `readArchiveEntries` — the single test boundary for archives. |
| `tests/inference-runs.test.ts` | Release-context mock built from `createTestServerContext`. |

---

### Task 1: Build the release-context mock from `createTestServerContext` (finding 5)

`releaseModelRequest(ctx: ServerContext, token: string)` takes a **full** `ServerContext`. The current mock brands a partial literal through a zod validator that only checks `typeof value === 'object'`, so `tsc` cannot see missing fields — which is why Task 11's field grouping broke this file at runtime twice.

`LlamaRunRecorder` is a class whose constructor writes a row via `createInferenceRun`, so it cannot be constructed here without creating a second run and breaking the assertions. One narrow brand therefore remains for `lastStartupLogs` only — but it now validates the exact field the code under test reads, and every other field comes from the real fixture.

**Files:**
- Modify: `tests/inference-runs.test.ts:48-54` (helper), `:230-250` and `:288-306` (call sites)

- [ ] **Step 1: Replace the branded helper**

Replace lines 48-54 of `tests/inference-runs.test.ts`:

```ts
// Brand a partial server-ops context fixture at one boundary.
const ReleaseModelRequestCtxSchema = z.custom<Parameters<typeof releaseModelRequest>[0]>(
  (value) => typeof value === 'object' && value !== null,
);
function mockReleaseCtx(ctx: object): Parameters<typeof releaseModelRequest>[0] {
  return ReleaseModelRequestCtxSchema.parse(ctx);
}
```

with:

```ts
/**
 * `releaseModelRequest` reads only `managedLlama.lastStartupLogs?.runId`, but a real
 * `LlamaRunRecorder` cannot be built here: its constructor writes an inference-run row and would
 * invalidate the assertions below. This is the one branded value in the file, and its predicate
 * checks exactly the field the code under test reads. Everything else comes from the real fixture,
 * so a future `ServerContext` migration fails at compile time instead of at runtime.
 */
function isRunIdCarrier(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && 'runId' in value
    && typeof Reflect.get(value, 'runId') === 'string';
}

const StartupLogsSchema = z.custom<LlamaRunRecorder>(isRunIdCarrier);

function releaseModelRequestCtx(options: {
  activeModelRequests: ServerContext['activeModelRequests'];
  inferenceRunFlushQueue: InferenceRunFlushQueue;
  startupLogRunId: string;
}): ServerContext {
  const base = createTestServerContext(
    path.join(createManagedTempDir('siftkit-release-ctx-'), 'config.json'),
  );
  return {
    ...base,
    activeModelRequests: options.activeModelRequests,
    inferenceRunFlushQueue: options.inferenceRunFlushQueue,
    managedLlama: {
      ...base.managedLlama,
      lastStartupLogs: StartupLogsSchema.parse({
        runId: options.startupLogRunId,
        purpose: 'startup',
        scriptPath: 'fake-launcher.cmd',
        baseUrl: 'http://127.0.0.1:8080',
      }),
    },
  };
}
```

- [ ] **Step 2: Add the imports it needs**

Add to the import block at the top of `tests/inference-runs.test.ts`:

```ts
import path from 'node:path';

import type { LlamaRunRecorder } from '../src/status-server/llama-run-recorder.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

`AppliedModelPresetState`, `getActiveModelPreset` and `getDefaultConfig` become unused once Step 3 lands — remove those three imports; `eslint` will fail the build otherwise.

- [ ] **Step 3: Rewrite both call sites**

At `tests/inference-runs.test.ts:230`, replace:

```ts
    const released = releaseModelRequest(mockReleaseCtx({
      activeModelRequests: new Map([['token-1', {
        token: 'token-1',
        kind: 'dashboard_chat_stream',
        startedAtUtc: new Date().toISOString(),
        ownerRunId: null,
      }]]),
      appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(getDefaultConfig())),
      modelRequestQueue: [],
      terminalMetadata: { lastModelRequestFinishedAtMs: null },
      idleSummary: { pending: false, timer: null },
      managedLlama: {
        lastStartupLogs: {
          runId: run.id,
          purpose: 'startup',
          scriptPath: 'fake-launcher.cmd',
          baseUrl: 'http://127.0.0.1:8080',
        },
      },
      inferenceRunFlushQueue: flushQueue,
    }), 'token-1');
```

with:

```ts
    const released = releaseModelRequest(releaseModelRequestCtx({
      activeModelRequests: new Map([['token-1', {
        token: 'token-1',
        kind: 'dashboard_chat_stream',
        startedAtUtc: new Date().toISOString(),
        ownerRunId: null,
      }]]),
      inferenceRunFlushQueue: flushQueue,
      startupLogRunId: run.id,
    }), 'token-1');
```

Apply the same substitution at `:288` (the `mockReleaseCtx({ … })` assigned to `const ctx`), keeping its `'token-locked'` / `'repo_search'` values:

```ts
    const ctx = releaseModelRequestCtx({
      activeModelRequests: new Map([['token-locked', {
        token: 'token-locked',
        kind: 'repo_search',
        startedAtUtc: new Date().toISOString(),
        ownerRunId: null,
      }]]),
      inferenceRunFlushQueue: flushQueue,
      startupLogRunId: run.id,
    });
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && npm run test -- inference-runs`
Expected: `pass 18`, `fail 0`.

Run: `npm run typecheck`
Expected: clean, no output after the `eslint .` banner.

- [ ] **Step 5: Prove the compiler now catches the migration it missed**

Temporarily delete the `queue: [],` line from the `terminalMetadata` literal in `tests/helpers/server-context-fixture.ts`.

Run: `npm run typecheck`
Expected: FAIL with `Property 'queue' is missing in type … TerminalMetadataState`.

Restore the line and re-run `npm run typecheck` — clean. This is the whole point of the task; do not skip it.

- [ ] **Step 6: Commit**

```bash
git add tests/inference-runs.test.ts
git commit -m "test(inference-runs): build the release context from the real fixture"
```

---

### Task 2: One request-body loop behind an explicit `BodySink` (finding 4)

`readBodyToFile` duplicates ~40 lines of `readBodyBytes`' settle/cleanup/listener machinery, including the load-bearing `req.complete` mid-body-disconnect guard.

**Files:**
- Modify: `src/status-server/http-utils.ts:30-172`
- Test: `tests/http-utils-read-body.test.ts`, `tests/http-utils-read-body-to-file.test.ts` (both exist; they are the characterization net — do not change them)

- [ ] **Step 1: Confirm the net is green before touching anything**

Run: `npm run build:test && npm run test -- http-utils-read-body`
Expected: `pass 6`, `fail 0`.

- [ ] **Step 2: Add the sink interface and its two implementations**

Insert into `src/status-server/http-utils.ts`, immediately after the `RequestBodyTooLargeError` class:

```ts
/**
 * Where a streamed request body goes. Exactly one of `close` (body complete and accepted) or
 * `discard` (read failed) runs, so a sink that holds an fd or a temp file always releases it.
 */
interface BodySink {
  write(chunk: Buffer): void;
  close(): void;
  discard(): void;
}

/** Collects the body in memory for `readBody`. */
class BufferBodySink implements BodySink {
  private readonly chunks: Buffer[] = [];
  private collected: Buffer | null = null;

  write(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  close(): void {
    this.collected = Buffer.concat(this.chunks);
    this.chunks.length = 0;
  }

  discard(): void {
    this.chunks.length = 0;
  }

  take(): Buffer {
    if (this.collected === null) {
      throw new Error('Request body was not collected.');
    }
    return this.collected;
  }
}

/** Writes the body straight to disk, leaving nothing behind when the read fails. */
class FileBodySink implements BodySink {
  private readonly fd: number;
  private written = 0;

  constructor(private readonly destinationPath: string) {
    this.fd = fs.openSync(destinationPath, 'w');
  }

  write(chunk: Buffer): void {
    fs.writeSync(this.fd, chunk, 0, chunk.byteLength, this.written);
    this.written += chunk.byteLength;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  discard(): void {
    fs.closeSync(this.fd);
    fs.rmSync(this.destinationPath, { force: true });
  }
}
```

- [ ] **Step 3: Replace both readers with one loop**

Replace everything from `export function readBodyBytes(` through the closing brace of `readBodyToFile` (currently `src/status-server/http-utils.ts:33-172`) with:

```ts
/**
 * The one body-reading loop. Oversize bodies reject with `RequestBodyTooLargeError`; a mid-body
 * disconnect rejects rather than hanging, because `end` never fires and only `close` is left to
 * settle the promise. The sink decides where the bytes land.
 */
function consumeBody(req: IncomingMessage, maxBytes: number, sink: BodySink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;

    const detach = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      detach();
      sink.close();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      detach();
      sink.discard();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        settleReject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      try {
        sink.write(chunk);
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
        req.destroy();
      }
    };
    const onEnd = (): void => settleResolve();
    const onAborted = (): void => settleReject(new Error('Request aborted before the body was received.'));
    const onError = (error: Error): void => settleReject(error);
    const onClose = (): void => {
      // On a complete message 'end' already ran and the `settled` guard makes this inert. On a
      // mid-body disconnect 'end' never fires, and this is what stops the promise hanging forever.
      if (req.complete) return;
      settleReject(new Error('Request closed before the body was received.'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function resolveMaxBytes(maxBytes: number | undefined): number {
  return Number.isFinite(maxBytes) && Number(maxBytes) > 0
    ? Math.trunc(Number(maxBytes))
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export async function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const sink = new BufferBodySink();
  await consumeBody(req, resolveMaxBytes(options.maxBytes), sink);
  return sink.take().toString('utf8');
}

/**
 * Streams a request body straight to a file, enforcing the same byte ceiling as `readBody` without
 * ever holding the body. A rejected read leaves no file behind, so the caller's failure path has
 * nothing to remember. Used by §16.4 restore uploads, which are whole backups.
 */
export function readBodyToFile(
  req: IncomingMessage,
  destinationPath: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  return consumeBody(req, resolveMaxBytes(options.maxBytes), new FileBodySink(destinationPath));
}
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && npm run test -- http-utils-read-body`
Expected: `pass 6`, `fail 0`.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/http-utils.ts
git commit -m "refactor(status-server): one body-reading loop behind an explicit sink"
```

---

### Task 3: Extract the zip header codecs into `zip.ts` (finding 3)

`ZipWriter.build()` and `ZipFileWriter` write the same field offsets; `readZip` and `ZipFileReader` parse them. `MAX_COMMENT_LENGTH` is defined twice with the same comment. This task extracts the codecs and ports both streaming classes onto them, leaving `ZipWriter`/`readZip` working so the suite stays green — Task 4 deletes them.

**Files:**
- Modify: `src/lib/zip.ts`, `src/lib/zip-file-writer.ts`, `src/lib/zip-file-reader.ts`

- [ ] **Step 1: Add the codecs to `zip.ts`**

Insert into `src/lib/zip.ts` immediately after the `crc32` function, and change `const MAX_COMMENT_LENGTH = 65_535;` to `export const MAX_COMMENT_LENGTH = 65_535;`:

```ts
/** The fields both header records carry; the writer supplies them, the reader recovers them. */
export interface ZipEntryFields {
  readonly name: Buffer;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export function encodeLocalHeader(entry: ZipEntryFields): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt32LE(0, 10); // dos time/date: zero, deterministic
  header.writeUInt32LE(entry.crc, LOCAL_HEADER_CRC_OFFSET);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(entry.name.byteLength, 26);
  header.writeUInt16LE(0, 28); // extra length
  return header;
}

export function encodeCentralHeader(entry: ZipEntryFields, localOffset: number): Buffer {
  const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  // 30..41: extra, comment, disk number, and attributes are all zero.
  header.writeUInt32LE(localOffset, 42);
  return header;
}

export function encodeEocd(entryCount: number, centralSize: number, centralStart: number): Buffer {
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return eocd;
}

export interface DecodedCentralEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  /** How far to advance the cursor to reach the next central-directory record. */
  readonly recordLength: number;
}

export function decodeCentralHeader(central: Buffer, cursor: number): DecodedCentralEntry {
  if (central.readUInt32LE(cursor) !== CENTRAL_HEADER) {
    throw new Error('Zip central directory entry is corrupt.');
  }
  const nameLength = central.readUInt16LE(cursor + 28);
  const extraLength = central.readUInt16LE(cursor + 30);
  const commentLength = central.readUInt16LE(cursor + 32);
  const name = central
    .subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)
    .toString('utf8');
  const method = central.readUInt16LE(cursor + 10);
  if (method !== 0 && method !== 8) {
    throw new Error(`Zip entry ${name} uses unsupported compression method ${method}.`);
  }
  return {
    name,
    method,
    crc: central.readUInt32LE(cursor + 16),
    compressedSize: central.readUInt32LE(cursor + 20),
    uncompressedSize: central.readUInt32LE(cursor + 24),
    localOffset: central.readUInt32LE(cursor + 42),
    recordLength: CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength,
  };
}

/** Offset of the EOCD record inside `tail`, or -1 when the tail holds no archive end. */
export function findEocdOffset(tail: Buffer): number {
  for (let index = tail.byteLength - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) return index;
  }
  return -1;
}

/** Payload offset for an entry, read out of its local header (name and extra repeat there). */
export function localHeaderDataOffset(localOffset: number, localHeader: Buffer): number {
  return localOffset + LOCAL_HEADER_SIZE + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
}
```

- [ ] **Step 2: Port `ZipFileWriter` onto the codecs**

In `src/lib/zip-file-writer.ts`, change the `zip.js` import to:

```ts
import {
  CRC32_SEED, LOCAL_HEADER_CRC_OFFSET,
  crc32, crc32Finish, crc32Update,
  encodeCentralHeader, encodeEocd, encodeLocalHeader,
} from './zip.js';
```

Replace the body of `writeCentralHeader` with:

```ts
  private writeCentralHeader(entry: WrittenEntry): void {
    this.append(encodeCentralHeader(entry, entry.offset));
    this.append(entry.name);
  }
```

Replace the header construction inside `writeEntryHeaderAndName` (everything from `const header = Buffer.alloc(LOCAL_HEADER_SIZE);` through `header.writeUInt16LE(0, 28); // extra length`) with:

```ts
    const fields = { name: nameBytes, method, crc, compressedSize, uncompressedSize };
    const header = encodeLocalHeader(fields);
```

Replace the EOCD construction in `finish()` (the five `eocd.*` lines plus its `Buffer.alloc`) with:

```ts
      this.append(encodeEocd(this.entries.length, this.offset - centralStart, centralStart));
```

`WrittenEntry` already carries `name`, `method`, `crc`, `compressedSize`, `uncompressedSize`, so it structurally satisfies `ZipEntryFields`; no change to that interface is needed.

- [ ] **Step 3: Port `ZipFileReader` onto the codecs**

In `src/lib/zip-file-reader.ts`, delete the local `const MAX_COMMENT_LENGTH = 65_535;` and its comment, and change the `zip.js` import to:

```ts
import {
  CRC32_SEED, EOCD_SIZE, LOCAL_HEADER_SIZE, MAX_COMMENT_LENGTH,
  crc32, crc32Finish, crc32Update,
  decodeCentralHeader, findEocdOffset, localHeaderDataOffset,
} from './zip.js';
```

Replace the body of `readCentralDirectory` after the `readExactly(fd, tail, tailLength, size - tailLength);` line with:

```ts
  const eocdOffset = findEocdOffset(tail);
  if (eocdOffset < 0) throw new Error('Zip end of central directory not found.');

  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralStart = tail.readUInt32LE(eocdOffset + 16);
  const central = Buffer.alloc(centralSize);
  readExactly(fd, central, centralSize, centralStart);

  const directory = new Map<string, DirectoryEntry>();
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const decoded = decodeCentralHeader(central, cursor);
    directory.set(decoded.name, {
      method: decoded.method,
      crc: decoded.crc,
      compressedSize: decoded.compressedSize,
      uncompressedSize: decoded.uncompressedSize,
      localOffset: decoded.localOffset,
    });
    cursor += decoded.recordLength;
  }
  return directory;
```

Replace the body of `dataStart` with:

```ts
  private dataStart(entry: DirectoryEntry): number {
    return localHeaderDataOffset(entry.localOffset, this.readRange(entry.localOffset, LOCAL_HEADER_SIZE));
  }
```

Narrow `DirectoryEntry.method` from `number` to `0 | 8` so it matches `DecodedCentralEntry`.

- [ ] **Step 4: Verify nothing moved a byte**

Run: `npm run build:test && npm run test -- zip`
Expected: `pass 21`, `fail 0` (`zip.test.ts` 6 + `zip-file-writer.test.ts` 9 + `zip-file-reader.test.ts` 6). `zip.test.ts` still exercising the untouched `ZipWriter`/`readZip` is what proves the byte layout is unchanged.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zip.ts src/lib/zip-file-writer.ts src/lib/zip-file-reader.ts
git commit -m "refactor(lib): share zip header codecs between the streaming writer and reader"
```

---

### Task 4: Delete `ZipWriter` and `readZip` (finding 1)

Neither has a production caller. Six test files use `readZip` as an oracle and two use `ZipWriter`; all move to the streaming pair via one helper, so the call sites stay one-liners.

**Files:**
- Modify: `tests/helpers/archive-bytes.ts`, `tests/zip.test.ts`, `tests/zip-file-writer.test.ts`, `tests/assistant-backup-restore.test.ts`, `tests/assistant-export.test.ts`, `tests/assistant-gate-e-e2e.test.ts`, `tests/assistant-gate-e-routes.test.ts`, `tests/assistant-archive-streaming.test.ts`
- Modify: `src/lib/zip.ts` (delete `ZipWriter`, `readZip`, `Entry`, `findEocd`, the `node:zlib` import)

- [ ] **Step 1: Add the archive-reading helpers**

Append to `tests/helpers/archive-bytes.ts`:

```ts
/** Every entry of an on-disk archive, for tests that assert on contents. */
export function readArchiveEntries(archivePath: string): Map<string, Buffer> {
  const reader = ZipFileReader.open(archivePath);
  try {
    const entries = new Map<string, Buffer>();
    for (const name of reader.entryNames()) {
      entries.set(name, reader.readEntry(name));
    }
    return entries;
  } finally {
    reader.close();
  }
}

/** Reads a streamed archive's entries and cleans the archive up, the common assertion shape. */
export async function archiveEntries(archive: Promise<TempArchive>): Promise<Map<string, Buffer>> {
  const finished = await archive;
  try {
    return readArchiveEntries(finished.path);
  } finally {
    finished.cleanup();
  }
}

/** For tests holding raw bytes (an HTTP response body) rather than a path. */
export function readArchiveEntriesFromBytes(bytes: Buffer): Map<string, Buffer> {
  return readArchiveEntries(archiveUploadPath(bytes));
}
```

and add its import:

```ts
import { ZipFileReader } from '../../src/lib/zip-file-reader.js';
```

- [ ] **Step 2: Migrate the archive assertion call sites**

In `tests/assistant-backup-restore.test.ts`, `tests/assistant-export.test.ts` and `tests/assistant-gate-e-e2e.test.ts`, replace every

```ts
readZip(await archiveBytes(X))
```

with

```ts
await archiveEntries(X)
```

In `tests/assistant-gate-e-routes.test.ts` and `tests/assistant-archive-streaming.test.ts`, replace `readZip(<bytes>)` with `readArchiveEntriesFromBytes(<bytes>)`.

Update each file's imports: drop `import { readZip } from '../src/lib/zip.js';` and add the helpers used from `'./helpers/archive-bytes.js'`.

- [ ] **Step 3: Rewrite `rebuild` in `tests/assistant-backup-restore.test.ts`**

Replace lines 140-145:

```ts
/** Re-zips an entry map, so a test can mutate entries and hand the result back to restore. */
function rebuild(archive: Map<string, Buffer>): Buffer {
  const writer = new ZipWriter();
  for (const [name, bytes] of archive) writer.add(name, bytes);
  return writer.build();
}
```

with:

```ts
/** Re-zips an entry map to a temp file, so a test can mutate entries and hand the path to restore. */
function rebuild(archive: Map<string, Buffer>): string {
  const uploadPath = path.join(createManagedTempDir('siftkit-test-rebuild-'), 'rebuilt.zip');
  const writer = new ZipFileWriter(uploadPath);
  for (const [name, bytes] of archive) writer.addBuffer(name, bytes);
  writer.finish();
  return uploadPath;
}
```

Then drop the now-redundant `archiveUploadPath(...)` wrapper at the three `preview(archiveUploadPath(rebuild(archive)))` sites so they read `preview(rebuild(archive))`. Swap the `ZipWriter, readZip` import for `import { ZipFileWriter } from '../src/lib/zip-file-writer.js';`.

- [ ] **Step 4: Rewrite `tests/zip.test.ts` onto `ZipFileWriter`/`ZipFileReader`**

Replace the whole file with:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ZipFileReader } from '../src/lib/zip-file-reader.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { readArchiveEntries } from './helpers/archive-bytes.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function build(entries: readonly (readonly [string, Buffer])[], prefix: string): string {
  const archivePath = path.join(createManagedTempDir(prefix), 'a.zip');
  const writer = new ZipFileWriter(archivePath);
  for (const [name, data] of entries) writer.addBuffer(name, data);
  writer.finish();
  return archivePath;
}

test('round-trips stored and deflated entries byte-for-byte', () => {
  const archivePath = build([
    ['manifest.json', Buffer.from('{"a":1}')],
    ['blobs/aa/deadbeef', Buffer.alloc(70_000, 7)], // compressible, > one chunk
    ['empty.txt', Buffer.alloc(0)],
  ], 'zip-roundtrip-');

  const entries = readArchiveEntries(archivePath);
  assert.deepEqual([...entries.keys()].sort(), ['blobs/aa/deadbeef', 'empty.txt', 'manifest.json']);
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"a":1}');
  assert.equal(entries.get('blobs/aa/deadbeef')?.equals(Buffer.alloc(70_000, 7)), true);
  assert.equal(entries.get('empty.txt')?.byteLength, 0);
});

test('the same input always produces the same archive bytes', () => {
  const first = build([['a.txt', Buffer.from('alpha')], ['b.bin', Buffer.alloc(4096, 3)]], 'zip-stable-1-');
  const second = build([['a.txt', Buffer.from('alpha')], ['b.bin', Buffer.alloc(4096, 3)]], 'zip-stable-2-');
  assert.equal(fs.readFileSync(first).equals(fs.readFileSync(second)), true);
});

test('preserves non-ASCII entry names', () => {
  const archivePath = build([['topics/café-münchen.md', Buffer.from('naïve')]], 'zip-utf8-');
  assert.equal(readArchiveEntries(archivePath).get('topics/café-münchen.md')?.toString('utf8'), 'naïve');
});

test('rejects a corrupted entry via CRC mismatch', () => {
  // High-entropy 8 bytes: deflate cannot shrink them, so the writer picks method 0 (store)
  // and the flipped byte reaches the CRC check instead of dying inside inflate.
  const archivePath = build([['a.bin', Buffer.from('9f8e7d6c5b4a3210', 'hex').subarray(0, 8)]], 'zip-crc-');
  const archive = fs.readFileSync(archivePath);
  archive[30 + 'a.bin'.length + 2] ^= 0xff; // inside the stored data
  fs.writeFileSync(archivePath, archive);

  const reader = ZipFileReader.open(archivePath);
  try {
    assert.throws(() => reader.readEntry('a.bin'), /CRC/u);
  } finally {
    reader.close();
  }
});

test('rejects non-zip input', () => {
  const notZip = path.join(createManagedTempDir('zip-notzip-'), 'not.zip');
  fs.writeFileSync(notZip, Buffer.from('not a zip'));
  assert.throws(() => ZipFileReader.open(notZip), /end of central directory/iu);
});

test('rejects a truncated archive rather than returning partial entries', () => {
  const archivePath = build([['a.txt', Buffer.from('alpha')]], 'zip-truncated-');
  const archive = fs.readFileSync(archivePath);
  const truncated = path.join(createManagedTempDir('zip-truncated-out-'), 'a.zip');
  fs.writeFileSync(truncated, archive.subarray(0, archive.byteLength - 4));
  assert.throws(() => ZipFileReader.open(truncated));
});
```

- [ ] **Step 5: Migrate `tests/zip-file-writer.test.ts` off `readZip`**

Replace `import { readZip } from '../src/lib/zip.js';` with `import { readArchiveEntries } from './helpers/archive-bytes.js';`, rename the first test to `'ZipFileWriter output is readable by ZipFileReader'`, and replace each `readZip(fs.readFileSync(archivePath))` with `readArchiveEntries(archivePath)`. For the two sites that read a mutated in-memory `archive` buffer, write it back to a path first and call `readArchiveEntries` on that path.

- [ ] **Step 6: Delete the dead implementations**

From `src/lib/zip.ts`, delete: the `import { deflateRawSync, inflateRawSync } from 'node:zlib';` line, the `Entry` interface, the entire `ZipWriter` class, the entire `readZip` function and the private `findEocd` function. Update the module doc comment to:

```ts
/**
 * Minimal zip container (PKWARE APPNOTE): methods 0 (store) and 8 (deflate), no zip64.
 * Dependency-free on purpose — the assistant export and backup archives must be readable by
 * Windows Explorer and `Expand-Archive` without SiftKit shipping a compression library.
 *
 * This module owns the format only: constants, CRC32, and the header codecs. `ZipFileWriter`
 * and `ZipFileReader` are the sole writer and reader built on it.
 */
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck`
Expected: clean. Any surviving `ZipWriter`/`readZip` import fails here — that is the loud failure the directive asks for.

Run: `npm run build:test && npm run test -- zip assistant`
Expected: `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/zip.ts tests/zip.test.ts tests/zip-file-writer.test.ts tests/helpers/archive-bytes.ts tests/assistant-backup-restore.test.ts tests/assistant-export.test.ts tests/assistant-gate-e-e2e.test.ts tests/assistant-gate-e-routes.test.ts tests/assistant-archive-streaming.test.ts
git commit -m "refactor(lib): delete the in-memory zip writer and reader"
```

---

### Task 5: Automate the external-tool compatibility check

Deleting `readZip` removes the second implementation that cross-checked `ZipFileWriter`. The genuinely independent oracle is Windows' own unzip, which until now was only ever run by hand. Automate it so the guarantee in the `zip.ts` module doc is tested.

**Files:**
- Create: `tests/zip-external-tool.test.ts`

- [ ] **Step 1: Write the test**

```ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { POWERSHELL_EXECUTABLE } from '../src/lib/powershell.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const PAYLOAD = Buffer.alloc(300_000, 42);

/**
 * The module doc for `src/lib/zip.ts` promises archives that Windows can open without SiftKit's
 * own reader. `ZipFileReader` cannot prove that — only a foreign unzip can.
 */
test('ZipFileWriter output opens with Expand-Archive', { skip: process.platform !== 'win32' }, async () => {
  const dir = createManagedTempDir('zip-external-');
  const source = path.join(dir, 'payload.bin');
  fs.writeFileSync(source, PAYLOAD);

  const archivePath = path.join(dir, 'compat.zip');
  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('manifest.json', Buffer.from('{"x":1}', 'utf8'));
  await writer.addFile('blobs/payload.bin', source);
  writer.finish();

  const outDir = path.join(dir, 'out');
  const result = spawnSync(POWERSHELL_EXECUTABLE, [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, `Expand-Archive failed: ${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'), '{"x":1}');
  assert.equal(fs.readFileSync(path.join(outDir, 'blobs', 'payload.bin')).equals(PAYLOAD), true);
});
```

- [ ] **Step 2: Run it**

Run: `npm run build:test && npm run test -- zip-external-tool`
Expected on Windows: `pass 1`, `fail 0`. Elsewhere: `skipped 1`.

- [ ] **Step 3: Prove it can fail**

Temporarily change `header.writeUInt16LE(0x0800, 6);` to `header.writeUInt16LE(0, 6);` in `encodeLocalHeader` and re-run. Expected: the non-ASCII assertion in `tests/zip.test.ts` fails (the flag bit is what declares UTF-8 names). Restore the line. If neither suite reacts, the oracle is not wired up — fix that before moving on.

- [ ] **Step 4: Commit**

```bash
git add tests/zip-external-tool.test.ts
git commit -m "test(lib): prove the streamed archive opens with a foreign unzip"
```

---

### Task 6: Make `ZipFileReader` genuinely async behind an explicit `ChunkSink` (findings 2 and 7)

`extractTo` is declared `async` but contains no `await` — it blocks the event loop for the whole restore, which defeats the streaming goal and misleads every caller. `forEachStoredChunk` takes a dynamically-passed callback, which the directives forbid outside an external API. Both are fixed by one change: an explicit sink interface with two stateful implementations, driven by a genuinely async walk.

Making `hashEntry` async cascades to `RestoreService.verifyEntries` → `preview` → `AssistantService.previewRestore` → `restorePreviewEndpoint`. In `src/` that is exactly two call sites; `AssistantRuntime` does not declare `previewRestore`, so the interface is unaffected.

**Files:**
- Modify: `src/lib/zip-file-reader.ts`, `src/assistant/control/restore-service.ts`, `src/assistant/assistant-service.ts:622-624`, `src/status-server/routes/assistant/admin-routes.ts:84`
- Test: `tests/zip-file-reader.test.ts`, `tests/assistant-backup-restore.test.ts`, `tests/assistant-gate-e-e2e.test.ts`

- [ ] **Step 1: Write the failing test that pins non-blocking behaviour**

Add to `tests/zip-file-reader.test.ts`:

```ts
test('ZipFileReader yields to the event loop while extracting', async () => {
  const { dir, archivePath } = await buildFixture('zipr-nonblocking-');
  const reader = ZipFileReader.open(archivePath);
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 1);
  try {
    await reader.extractTo('blobs/blob.bin', path.join(dir, 'restored.bin'));
  } finally {
    clearInterval(ticker);
    reader.close();
  }
  assert.ok(ticks > 0, 'a synchronous extract starves timers; this must not block the event loop');
});
```

Raise `BLOB_BYTES` in that file from `300_000` to `8_000_000` so the extract spans more than one chunk and more than one timer tick.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test && npm run test -- zip-file-reader`
Expected: FAIL — `a synchronous extract starves timers; this must not block the event loop`.

- [ ] **Step 3: Replace the callback walk with an async sink walk**

In `src/lib/zip-file-reader.ts`, add above the class:

```ts
/**
 * Where a stored entry's chunks go. Explicit implementations rather than a callback, so the walk
 * has a named dependency and the CRC check below cannot be bypassed by a caller that stops early.
 */
interface ChunkSink {
  write(chunk: Buffer): Promise<void>;
}

class HashChunkSink implements ChunkSink {
  private readonly hash = createHash('sha256');

  async write(chunk: Buffer): Promise<void> {
    this.hash.update(chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

class FileChunkSink implements ChunkSink {
  private written = 0;

  constructor(private readonly handle: fs.promises.FileHandle) {}

  async write(chunk: Buffer): Promise<void> {
    await this.handle.write(chunk, 0, chunk.byteLength, this.written);
    this.written += chunk.byteLength;
  }
}
```

Replace `hashEntry`, `extractTo` and `forEachStoredChunk` with:

```ts
  /** sha256 of the uncompressed entry, computed chunk by chunk for stored entries. */
  async hashEntry(name: string): Promise<string> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      return createHash('sha256').update(this.readEntry(name)).digest('hex');
    }
    const sink = new HashChunkSink();
    await this.walkStored(name, entry, sink);
    return sink.digest();
  }

  /** Chunked extraction for stored entries; CRC verified over the stream. */
  async extractTo(name: string, destinationPath: string): Promise<void> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      await fs.promises.writeFile(destinationPath, this.readEntry(name));
      return;
    }
    const handle = await fs.promises.open(destinationPath, 'w');
    try {
      await this.walkStored(name, entry, new FileChunkSink(handle));
    } catch (error) {
      await handle.close();
      await fs.promises.rm(destinationPath, { force: true });
      throw error;
    }
    await handle.close();
  }

  /** Walks a stored entry a chunk at a time and throws unless the CRC matches. */
  private async walkStored(name: string, entry: DirectoryEntry, sink: ChunkSink): Promise<void> {
    const start = this.dataStart(entry);
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let crc = CRC32_SEED;
    let position = 0;
    while (position < entry.compressedSize) {
      const toRead = Math.min(READ_CHUNK_BYTES, entry.compressedSize - position);
      await this.readExactlyAsync(chunk, toRead, start + position);
      const view = chunk.subarray(0, toRead);
      crc = crc32Update(crc, view);
      await sink.write(view);
      position += toRead;
    }
    if (crc32Finish(crc) !== entry.crc) {
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
  }

  private async readExactlyAsync(buffer: Buffer, length: number, position: number): Promise<void> {
    let read = 0;
    while (read < length) {
      const result = await this.handle.read(buffer, read, length - read, position + read);
      if (result.bytesRead === 0) {
        throw new Error('Zip archive ended before the expected number of bytes.');
      }
      read += result.bytesRead;
    }
  }
```

`ZipFileReader` now needs an async `FileHandle` alongside the sync `fd` used by `open`/`readEntry`/`dataStart`. Change `open` to keep both: open the path once with `fs.promises.open`, take `handle.fd` for the synchronous small reads, store the handle for the chunked ones, and make `close()` `await this.handle.close()`. That makes `ZipFileReader.open` async too — rename it `ZipFileReader.openAsync` is **not** wanted; keep the name `open` and make it `static async open(archivePath: string): Promise<ZipFileReader>`.

- [ ] **Step 4: Propagate `await` to every reader call site**

`ZipFileReader.open`, `hashEntry`, `extractTo` and `close` are now async. Update:

- `tests/zip-file-reader.test.ts` and `tests/zip.test.ts`: `const reader = await ZipFileReader.open(...)`, `await reader.close()`, `await reader.hashEntry(...)`, and `await assert.rejects(...)` where `assert.throws` wrapped a now-async call.
- `tests/helpers/archive-bytes.ts`: make `readArchiveEntries` async (`await ZipFileReader.open`, `await reader.close()`), and `readArchiveEntriesFromBytes` async; `archiveEntries` already returns a promise. Await them at every call site migrated in Task 4.
- `src/assistant/control/restore-service.ts`: `verifyEntries` becomes `private async verifyEntries(reader: ZipFileReader): Promise<void>` with `if (reader.hashEntry(name) !== hash)` becoming `if (await reader.hashEntry(name) !== hash)`; `preview` becomes `async preview(uploadPath: string): Promise<AssistantRestorePreviewResponse>` with `await ZipFileReader.open(...)`, `await this.verifyEntries(reader)` and `await reader.close()`; `confirm` gains `await` on the same three.
- `src/assistant/assistant-service.ts:622-624`:

```ts
  previewRestore(uploadPath: string): Promise<AssistantRestorePreviewResponse> {
    return this.restoreService.preview(uploadPath);
  }
```

- `src/status-server/routes/assistant/admin-routes.ts:84`: `sendJson(res, 200, await service.previewRestore(uploadPath));`
- `tests/assistant-backup-restore.test.ts`: every `restores.preview(...)` / `restoreServiceFor(context).preview(...)` gains `await`; the two `assert.throws(() => …preview(…), /hash|schema/iu)` become `await assert.rejects(…preview(…), /hash|schema/iu)`.
- `tests/assistant-gate-e-e2e.test.ts:319`: `const preview = await service.previewRestore(...)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test && npm run test -- zip assistant http-utils`
Expected: `fail 0`, including the new non-blocking test.

Run: `npm run typecheck`
Expected: clean. A missed `await` on `preview` surfaces here as `Promise<…>` is not assignable.

- [ ] **Step 6: Commit**

```bash
git add src/lib/zip-file-reader.ts src/assistant/control/restore-service.ts src/assistant/assistant-service.ts src/status-server/routes/assistant/admin-routes.ts tests/zip-file-reader.test.ts tests/zip.test.ts tests/helpers/archive-bytes.ts tests/assistant-backup-restore.test.ts tests/assistant-gate-e-e2e.test.ts
git commit -m "perf(lib): stream zip extraction without blocking the event loop"
```

---

### Task 7: One `cleanup()` semantic on the temp archive (finding 8)

`TempArchiveBuilder.cleanup()` calls `writer.abort()`, which deletes the archive — so calling it after `finish()` silently destroys a finished archive a caller may still be streaming, despite the doc claiming it is "safe before or after `finish`". The returned `TempArchive.cleanup()` is a different, non-destructive closure with the same name.

**Files:**
- Modify: `src/assistant/control/temp-archive.ts`
- Test: `tests/assistant-archive-streaming.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/assistant-archive-streaming.test.ts`:

```ts
test('cleanup after finish removes the archive without a second abort path', () => {
  const builder = new TempArchiveBuilder('siftkit-archive-cleanup-');
  builder.writer.addBuffer('payload.bin', Buffer.from('kept', 'utf8'));
  const archive = builder.finish();

  assert.equal(fs.readFileSync(archive.path).byteLength > 0, true);
  builder.cleanup();
  assert.equal(fs.existsSync(archive.path), false);
  archive.cleanup(); // idempotent: the handle the caller holds must tolerate a double cleanup
  assert.equal(fs.existsSync(path.dirname(archive.path)), false);
});
```

Add `import { TempArchiveBuilder } from '../src/assistant/control/temp-archive.js';` to that file (it currently imports the type only).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test && npm run test -- assistant-archive-streaming`
Expected: FAIL — the first `readFileSync` succeeds, then `builder.cleanup()` runs `writer.abort()` on an already-finished writer, which throws `Zip archive already finished.` from `assertWritable` via `abort`'s guard ordering.

- [ ] **Step 3: Collapse to one cleanup**

Replace the body of `src/assistant/control/temp-archive.ts` from `export class TempArchiveBuilder {` to the end of the file with:

```ts
export class TempArchiveBuilder implements TempArchive {
  readonly writer: ZipFileWriter;
  readonly path: string;
  private readonly directory: string;
  private finished = false;

  constructor(prefix: string) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.path = path.join(this.directory, ARCHIVE_FILE_NAME);
    this.writer = new ZipFileWriter(this.path);
  }

  /** A path for an intermediate file, inside the directory `cleanup` already covers. */
  scratchPath(name: string): string {
    return path.join(this.directory, name);
  }

  /** Seals the archive and hands back the narrow handle the caller owns. */
  finish(): TempArchive {
    this.writer.finish();
    this.finished = true;
    return this;
  }

  /**
   * Removes the directory and everything in it. The only cleanup path, safe to call more than
   * once and in either state: an unfinished writer still holds an open fd, so it is closed first.
   */
  cleanup(): void {
    if (!this.finished) {
      this.writer.abort();
      this.finished = true;
    }
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test && npm run test -- assistant`
Expected: `fail 0`. `backup-service.ts` and `export-service.ts` need no change — both already call `builder.cleanup()` on failure and return `builder.finish()` on success.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/temp-archive.ts tests/assistant-archive-streaming.test.ts
git commit -m "refactor(assistant): one cleanup path for a temp archive"
```

---

### Task 8: Make the restore success path explicit (finding 10)

`confirm`'s `finally` infers "did the restore succeed?" from `!this.pending.has(uploadId)`. That condition means "not pending", not "succeeded"; a future edit that clears the map earlier, or an eviction from a concurrent `preview`, deletes a retryable upload on a failure path.

**Files:**
- Modify: `src/assistant/control/restore-service.ts:112-144`
- Test: `tests/assistant-backup-restore.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/assistant-backup-restore.test.ts`:

```ts
test('a failed confirm leaves the upload parked for a retry', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Nu Tool' });
    const restores = restoreServiceFor(context);
    const preview = await restores.preview(
      archiveUploadPath(await archiveBytes(backupServiceFor(context).createBackup())),
    );

    // Corrupt the parked archive so re-verification fails inside confirm.
    const uploadsDir = assistantRestoreUploadsDir(context.runtimeRoot);
    const parked = path.join(uploadsDir, `${preview.uploadId}.zip`);
    const bytes = fs.readFileSync(parked);
    bytes[bytes.byteLength - 40] ^= 0xff;
    fs.writeFileSync(parked, bytes);

    await assert.rejects(restores.confirm(preview.uploadId, preview.confirmToken));
    assert.equal(fs.existsSync(parked), true, 'a failed confirm must not delete the parked upload');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test && npm run test -- assistant-backup-restore`
Expected: FAIL — `a failed confirm must not delete the parked upload`. (`verifyEntries` throws before `this.pending.delete`, so `pending.has` is still true and the archive survives *today*; if this test passes as written, the corruption offset landed in the central directory rather than a stored payload — move it further from the end until `confirm` rejects with a CRC or hash error, then confirm the assertion still guards the delete.)

- [ ] **Step 3: Replace the inferred condition with an explicit path**

Replace `src/assistant/control/restore-service.ts:123-143` (from `const snapshotPath = …` through the closing brace of `finally`) with:

```ts
    const snapshotPath = path.join(this.uploadsDir, `${uploadId}.sqlite`);
    const reader = await ZipFileReader.open(request.archivePath);
    let recovered: boolean;
    try {
      // Re-verify: the parked file could have been swapped since the preview.
      await this.verifyEntries(reader);
      this.readManifest(reader);

      await this.replaceRows(reader, snapshotPath);
      await this.replaceBlobTree(reader);
      recovered = await this.recoverKey(reader);
    } finally {
      await reader.close();
      fs.rmSync(snapshotPath, { force: true });
    }

    // Only a completed restore retires the upload; a failure leaves it parked for a retry. The
    // reader is closed above, so Windows will let the archive go.
    this.pending.delete(uploadId);
    fs.rmSync(request.archivePath, { force: true });
    return {
      ok: true,
      blobsReadable: recovered,
      warning: recovered ? null : UNREADABLE_BLOBS_WARNING,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test && npm run test -- assistant-backup-restore assistant-gate-e`
Expected: `fail 0`, including the new test and the existing eviction/parking tests.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/restore-service.ts tests/assistant-backup-restore.test.ts
git commit -m "fix(assistant): retire a restore upload only when confirm succeeds"
```

---

### Task 9: Replace the invented §16.3 claim with the guarantee that actually holds (finding 9)

The old `ExportService` doc promised "an export never leaves plaintext in a temp file", and `addDecryptedBlobs` still cites §16.3 as forbidding plaintext on disk — which now contradicts its own enclosing method, since the archive it writes into *is* a temp file.

**That claim is not in the spec.** `docs/superpowers/specs/2026-08-13-assistant-gate-e-hardening-design.md:129-130` says the flag "decrypts them into the archive and writes an audit row"; line 198 explicitly parks restore uploads "in a temp file"; the only "plaintext never written" rule (line 39) is about the **backup key** under §16.4, which DPAPI still satisfies. So there is no product decision here — only a false comment to delete and a real guarantee to test.

**Files:**
- Modify: `src/assistant/control/export-service.ts:66-71` and `:132-133`
- Test: `tests/assistant-export.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/assistant-export.test.ts`:

```ts
test('a decrypted export leaves nothing on disk once cleaned up', async () => {
  await withAssistantContextAsync(async (context) => {
    const service = await seededExport(context);
    const archive = await service.export({ includeDecryptedBlobs: true });
    const directory = path.dirname(archive.path);

    // The archive is alone in a directory of its own, not loose in the shared temp root.
    // (Export writes no scratch files — unlike backup, which puts its sqlite snapshot here.)
    assert.deepEqual(fs.readdirSync(directory), ['archive.zip']);
    assert.match(path.basename(directory), /^siftkit-export-/u);

    archive.cleanup();
    assert.equal(fs.existsSync(directory), false, 'a decrypted export must not survive cleanup');
    archive.cleanup(); // idempotent
  });
});
```

Add `import fs from 'node:fs';` and `import path from 'node:path';` to that file.

- [ ] **Step 2: Run it to verify it fails or passes for the right reason**

Run: `npm run build:test && npm run test -- assistant-export`
Expected: PASS. This test documents behaviour that already holds; it fails only if `TempArchiveBuilder` stops isolating or stops cleaning up. Confirm it is load-bearing by temporarily commenting out the `fs.rmSync` in `TempArchiveBuilder.cleanup()` — the test must then fail — and restoring it.

- [ ] **Step 3: Correct both comments**

Replace the `ExportService` class doc (`src/assistant/control/export-service.ts:66-71`) with:

```ts
/**
 * §16.3 export: the user's memory as a portable zip — graph tables as JSON Lines, projections as
 * the markdown they already are, and evidence bytes only when explicitly asked for (design §3.1:
 * the flag decrypts them into the archive and writes an audit row). Entries are produced one at a
 * time and streamed into a temp archive, so the export never holds more than a single entry in
 * memory. With `includeDecryptedBlobs` that archive holds plaintext, so it lives alone in a
 * `mkdtemp` directory and is the caller's to delete: `cleanup()` is not optional.
 */
```

Replace the comment inside `addDecryptedBlobs` (`:132-133`) with:

```ts
      // Decrypted one blob at a time and released once written, so a large evidence tree never
      // lands in the heap all at once.
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && npm run test -- assistant-export`
Expected: `fail 0`.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/export-service.ts tests/assistant-export.test.ts
git commit -m "docs(assistant): state the export temp-archive guarantee the spec actually makes"
```

---

### Task 10: Prove the two retrofitted tests are load-bearing (finding 6)

`readBodyToFile` and `sendArchive` were implemented before their tests, so neither test has ever been observed failing for the right reason. This task runs a mutation check on each; any mutation that does not turn the suite red means the test is decorative and must be strengthened.

**Files:**
- Verify (and strengthen only if a mutation survives): `tests/assistant-archive-streaming.test.ts`, `tests/http-utils-read-body-to-file.test.ts`

- [ ] **Step 1: Mutate `sendArchive`'s cleanup**

In `src/status-server/routes/assistant/helpers.ts`, temporarily change the `finally { archive.cleanup(); }` block to `finally { /* mutation */ }`.

Run: `npm run build:test && npm run test -- assistant-archive-streaming`
Expected: FAIL on both tests — `archive directory must be removed`.

Restore the block and re-run. Expected: `pass 3` (including Task 7's new test), `fail 0`.

- [ ] **Step 2: Mutate the oversize discard**

In `src/status-server/http-utils.ts`, temporarily change `FileBodySink.discard()` to close the fd without removing the file:

```ts
  discard(): void {
    fs.closeSync(this.fd);
  }
```

Run: `npm run build:test && npm run test -- http-utils-read-body-to-file`
Expected: FAIL on two tests — `readBodyToFile rejects past the cap and leaves no partial file` and `readBodyToFile settles and cleans up when the client aborts mid-body`.

Restore `fs.rmSync(this.destinationPath, { force: true });` and re-run. Expected: `pass 3`, `fail 0`.

- [ ] **Step 3: Mutate the byte ceiling**

In `consumeBody`, temporarily change `if (totalBytes > maxBytes)` to `if (totalBytes > maxBytes * 1000)`.

Run: `npm run build:test && npm run test -- http-utils-read-body`
Expected: FAIL on `readBody rejects with RequestBodyTooLargeError past the cap` and `readBodyToFile rejects past the cap and leaves no partial file`.

Restore and re-run. Expected: `pass 6`, `fail 0`.

- [ ] **Step 4: Record the outcome**

If every mutation above turned the suite red, the tests are load-bearing and **no code change is needed** — note that in the commit message for Task 11 and move on. If any mutation survived, add the missing assertion to the relevant test before continuing; do not leave a decorative test in place.

- [ ] **Step 5: Confirm the tree is unmodified**

Run: `git status --short`
Expected: no entries beyond the unrelated user work listed under **Preconditions**. Any leftover mutation is a bug in this task.

---

### Task 11: Final gate

- [ ] **Step 1: Full typecheck and lint**

Run: `npm run typecheck`
Expected: clean through `eslint .`.

- [ ] **Step 2: Full suite**

Run: `npm run test`
Expected: `fail 0`, `skipped 2`, total ≥ 3249 (baseline 3247, plus Task 5's external-tool test, Task 6's non-blocking test, Task 7's cleanup test, Task 8's parked-upload test and Task 9's disk-hygiene test; minus none — `tests/zip.test.ts` keeps its six).

- [ ] **Step 3: Confirm the dead code is gone**

Run: `git grep -n "ZipWriter\|readZip" -- src tests`
Expected: no matches in `src/`; in `tests/` only the `zip-file-writer` test *name* if it still mentions the old oracle. Any `src/` match means Task 4 was incomplete.

- [ ] **Step 4: Confirm no callback walk or branded context survived**

Run: `git grep -n "consume: (chunk" -- src`
Expected: no matches.

Run: `git grep -n "mockReleaseCtx" -- tests`
Expected: no matches.

- [ ] **Step 5: Verify the unrelated user work is untouched**

Run: `git status --short`
Expected: exactly the paths listed under **Preconditions**, and nothing else.

- [ ] **Step 6: Update the handoff**

In `docs/superpowers/plans/2026-08-16-scalability-refactors-HANDOFF.md`, replace the "Open concern, deliberately accepted" paragraph under **Task 14** with a pointer to Task 9 of this plan and the spec lines that settle it, and add a line under **Suggested next steps** recording that the drift remediation is complete.

```bash
git add docs/superpowers/plans/2026-08-16-scalability-refactors-HANDOFF.md
git commit -m "docs: record the drift remediation outcome"
```

---

## Self-review notes

- **Coverage:** findings 1 (Task 4), 2 (Task 6), 3 (Task 3), 4 (Task 2), 5 (Task 1), 6 (Task 10), 7 (Task 6), 8 (Task 7), 9 (Task 9), 10 (Task 8). Task 5 exists to replace the oracle Task 4 removes; Task 11 is the gate.
- **Ordering constraints:** Task 3 must precede Task 4 (codecs before deletion). Task 6 must precede Task 8 (`confirm` gains `await` before its success path is rewritten). Task 2 must precede Task 10 Step 2 (the mutation targets `FileBodySink`, which Task 2 creates). Task 7 must precede Task 10 Step 1 (`pass 3` assumes Task 7's test exists).
- **Naming consistency:** `ChunkSink.write` (reader) and `BodySink.write` (http-utils) are deliberately distinct interfaces in different modules — do not merge them; their lifecycles differ (`close`/`discard` versus none).
- **Known risk:** Task 6 changes `ZipFileReader.open` to async, which is the widest blast radius in this plan. If Step 5 shows unrelated failures, check for a missed `await` before suspecting the walk itself.
