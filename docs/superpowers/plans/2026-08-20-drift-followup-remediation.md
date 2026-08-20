# Drift Follow-up Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close drift findings 1, 2, 3, 4, 5, 7, 9 and 10 from the 2026-08-19 reflection, so the streaming work is consistent on both the upload and download halves, `ZipFileReader` has exactly one (async) read path, and no comment or assertion message states something the code does not do.

**Architecture:** `BodySink.write` becomes async and `consumeBody` applies per-chunk backpressure, removing the last synchronous disk write from the request path. `ZipFileReader` drops its synchronous read mode entirely — one `readExactly` over the `FileHandle`, which makes `readEntry` async and turns the class doc's non-blocking claim into a true statement. `TempArchiveBuilder.finish` returns a handle that exposes only `path` and `cleanup`.

**Tech Stack:** TypeScript (strict, no casts / `any` / `!`), `node:test`, `node:fs/promises`, esbuild test bundling via `npm run build:test`.

---

## Findings covered

| # | Finding | Task |
|---|---|---|
| 1 | `FileBodySink.write` uses `fs.writeSync` on the request path | 1 |
| 2 | `RestoreService.preview` copies the whole upload with `copyFileSync` | 2 |
| 9 | `findEocdOffset` returns a `-1` sentinel every caller must check | 3 |
| 10 | Dual sync/async read modes on one handle, plus a `private get fd()` | 4 |
| 3 | Class doc overstates the non-blocking guarantee | 4 (dissolved by the fix) |
| 7 | `finish()` returns `this`, leaking `writer` and `scratchPath` | 5 |
| 4 | External-tool assertion message states a cause it cannot detect | 6 |
| 5 | Four assertions duplicated in `dashboard-status-server.test.ts` | 7 |

**Deliberately excluded** (user chose not to fix): finding 6 (`readArchiveEntriesFromBytes` round-trips through disk) and finding 8 (`BufferBodySink.take()` defensive throw). Leave both exactly as they are.

**Findings 3 and 10 are one change.** Deleting the synchronous read path (10) forces `readEntry` async, which makes the doc claim (3) true instead of narrowing it. Do not "fix" 3 by editing the comment — Task 4 removes the reason the comment was wrong.

---

## Preconditions

The working tree carries **unrelated user work** that must never be staged:

- `src/repo-search/execute.ts`, `src/status-server/dashboard-runs.ts`,
  `src/status-server/operation-progress-writers.ts`, `src/status-server/repo-agent-sessions.ts`,
  `src/status-server/routes/chat.ts`, `src/status-server/server-logger.ts`
- `tests/repo-search-preflight-log.test.ts`, `tests/repo-search-status-server.test.ts`,
  `tests/repo-search.test.ts`, `tests/server-logger.test.ts`
- `docs/superpowers/plans/2026-08-19-git-output-fidelity.md` (untracked)

Run `git status --short` before every commit and stage only the exact paths each task lists.

**Baseline to beat:** `npm run test` → 3253 tests, 3251 pass, 0 fail, 2 skipped. `npm run typecheck` (which also runs `eslint .`) → clean. After any `src/` or `tests/` change run `npm run build:test` before `npm run test -- <filter>`, or the runner aborts with "Test artifacts are stale".

**Known-flaky, not caused by this plan:** `tests/dashboard-status-server.test.ts` has a second load-sensitive test ("same session conflicts cover message plan and repo-search JSON and SSE routes") that holds a lock for 600 ms while making 18 sequential round-trips, and one full-suite run in five parked on `assistant-gate-d-e2e`. If either appears, re-run before investigating; do not attribute it to this plan without bisecting.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/status-server/http-utils.ts` | One body loop; `BodySink.write` is async; `consumeBody` pauses the request per chunk. No synchronous disk write. |
| `src/assistant/control/restore-service.ts` | Fully async: no `copyFileSync`, no `mkdirSync`; `readManifest`/`readManifestOnly` async. |
| `src/lib/zip.ts` | `findEocdOffset` throws rather than signalling with `-1`. |
| `src/lib/zip-file-reader.ts` | One async read path over the `FileHandle`. No `fd` getter, no sync `readExactly`, no sync `readRange`/`dataStart`/`readEntry`. |
| `src/assistant/control/temp-archive.ts` | `finish()` returns a `{ path, cleanup }` handle bound to the builder's single `cleanup`. |
| `tests/zip-external-tool.test.ts` | States only what it can detect. |
| `tests/dashboard-status-server.test.ts` | Token assertions live in the poll only. |

---

### Task 1: Async `BodySink` with per-chunk backpressure (finding 1)

`FileBodySink.write` calls `fs.writeSync` under a 512 MB `RESTORE_BODY_LIMIT`. Task 6 of the previous plan established that synchronous archive I/O on the status server is unacceptable and proved it with a regression test; this is the same defect on the sibling path, in code rewritten in the same session.

The change introduces concurrency where there was none, so the new risk is **write ordering**. That is what the new test guards. The refactor itself is covered by the six existing characterization tests, which were mutation-verified in the previous plan's Task 10.

**Files:**
- Modify: `src/status-server/http-utils.ts:34-88` (sinks), `:90-152` (`consumeBody`)
- Test: `tests/http-utils-read-body-to-file.test.ts` (add one), `tests/http-utils-read-body.test.ts` (unchanged)

- [ ] **Step 1: Confirm the net is green first**

Run: `npm run build:test && npm run test -- http-utils-read-body`
Expected: `pass 6`, `fail 0`.

- [ ] **Step 2: Write the ordering guard**

Append to `tests/http-utils-read-body-to-file.test.ts`:

```ts
test('readBodyToFile preserves byte order across many chunks', async () => {
  const server = await startBodyServer('read-body-file-order-', 32 * 1024 * 1024);
  // Position-dependent bytes: any reordered or dropped chunk changes the digest, which a
  // uniform fill would hide. Large enough to span thousands of socket chunks.
  const payload = Buffer.alloc(8 * 1024 * 1024);
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = (index * 31 + (index >> 13)) & 0xff;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: server.port, method: 'POST', path: '/', agent: testHttpAgent },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      );
      request.on('error', reject);
      request.end(payload);
    });

    assert.deepEqual(await waitForOutcome(server), { ok: true });
    assert.equal(
      createHash('sha256').update(fs.readFileSync(server.destinationPath)).digest('hex'),
      createHash('sha256').update(payload).digest('hex'),
      'chunks must land in arrival order',
    );
  } finally {
    await server.close();
  }
});
```

Add `import { createHash } from 'node:crypto';` to that file.

- [ ] **Step 3: Run it against the current synchronous writer**

Run: `npm run build:test && npm run test -- http-utils-read-body-to-file`
Expected: `pass 4`, `fail 0`. It passes now — synchronous writes cannot reorder. That is the point: it is the guard for the concurrency Step 4 introduces, not a red-green. Step 6 proves it is load-bearing.

- [ ] **Step 4: Make the sink async and add backpressure**

In `src/status-server/http-utils.ts`, change the interface and both implementations:

```ts
/**
 * Where a streamed request body goes. Exactly one of `close` (body complete and accepted) or
 * `discard` (read failed) runs, so a sink that holds an fd or a temp file always releases it.
 * `write` is async so a sink can reach disk without blocking the event loop; `consumeBody`
 * serialises the calls, so an implementation never sees overlapping writes.
 */
interface BodySink {
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
  discard(): Promise<void>;
}
```

```ts
/** Collects the body in memory for `readBody`. */
class BufferBodySink implements BodySink {
  private readonly chunks: Buffer[] = [];
  private collected: Buffer | null = null;

  async write(chunk: Buffer): Promise<void> {
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    this.collected = Buffer.concat(this.chunks);
    this.chunks.length = 0;
  }

  async discard(): Promise<void> {
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
  private written = 0;

  private constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly destinationPath: string,
  ) {}

  static async open(destinationPath: string): Promise<FileBodySink> {
    return new FileBodySink(await fs.promises.open(destinationPath, 'w'), destinationPath);
  }

  async write(chunk: Buffer): Promise<void> {
    await this.handle.write(chunk, 0, chunk.byteLength, this.written);
    this.written += chunk.byteLength;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async discard(): Promise<void> {
    await this.handle.close();
    await fs.promises.rm(this.destinationPath, { force: true });
  }
}
```

- [ ] **Step 5: Serialise the writes in `consumeBody`**

Replace `consumeBody` and `readBodyToFile` with:

```ts
/**
 * The one body-reading loop. Oversize bodies reject with `RequestBodyTooLargeError`; a mid-body
 * disconnect rejects rather than hanging, because `end` never fires and only `close` is left to
 * settle the promise. The sink decides where the bytes land.
 *
 * The request is paused for the duration of each write and resumed when it lands, so chunks reach
 * the sink in arrival order, at most one write is ever in flight, and a slow disk applies
 * backpressure to the socket instead of queueing the body in memory.
 */
function consumeBody(req: IncomingMessage, maxBytes: number, sink: BodySink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;
    let pending: Promise<void> = Promise.resolve();

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
      sink.close().then(resolve, reject);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      detach();
      sink.discard().then(() => reject(error), () => reject(error));
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        settleReject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      req.pause();
      pending = pending.then(() => sink.write(chunk)).then(
        () => {
          if (!settled) req.resume();
        },
        (error: unknown) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          req.destroy();
        },
      );
    };
    // `end` cannot arrive mid-write because the request is paused for the duration of each write,
    // but draining `pending` first makes that independent of stream-timing subtleties.
    const onEnd = (): void => {
      void pending.then(() => settleResolve());
    };
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
```

```ts
/**
 * Streams a request body straight to a file, enforcing the same byte ceiling as `readBody` without
 * ever holding the body. A rejected read leaves no file behind, so the caller's failure path has
 * nothing to remember. Used by §16.4 restore uploads, which are whole backups.
 */
export async function readBodyToFile(
  req: IncomingMessage,
  destinationPath: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  const sink = await FileBodySink.open(destinationPath);
  await consumeBody(req, resolveMaxBytes(options.maxBytes), sink);
}
```

`readBody` is unchanged apart from awaiting the now-async `close` implicitly — `consumeBody` already resolves after `sink.close()`, so `sink.take()` is still safe.

Note the `settled` guard now also stops a resume after settling, which is what prevents a destroyed request from being resumed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build:test && npm run test -- http-utils-read-body`
Expected: `pass 7`, `fail 0`.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Prove the ordering guard is load-bearing**

Temporarily drop the serialisation in `onData` so writes race:

```ts
      req.pause();
      void sink.write(chunk).then(() => { if (!settled) req.resume(); });
```

Run: `npm run build:test && npm run test -- http-utils-read-body-to-file`
Expected: FAIL on `readBodyToFile preserves byte order across many chunks` (digest mismatch) or on the byte-length assertion in the first test.

If it still passes, the payload is not large enough to interleave — raise it to 32 MB and retry. Do not proceed until a mutation fails this test.

Restore the `pending` chain and re-run. Expected: `pass 7`, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/http-utils.ts tests/http-utils-read-body-to-file.test.ts
git commit -m "perf(status-server): write request bodies to disk without blocking the event loop"
```

---

### Task 2: Async copy in `preview` (finding 2)

`preview` was made async so hashing could stream off the event loop, then blocks it copying the identical bytes.

**Files:**
- Modify: `src/assistant/control/restore-service.ts:93-96`

- [ ] **Step 1: Replace the synchronous filesystem calls**

Replace:

```ts
    const uploadId = `upload_${randomBytes(16).toString('hex')}`;
    const archivePath = path.join(this.uploadsDir, `${uploadId}.zip`);
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    fs.copyFileSync(uploadPath, archivePath);
```

with:

```ts
    const uploadId = `upload_${randomBytes(16).toString('hex')}`;
    const archivePath = path.join(this.uploadsDir, `${uploadId}.zip`);
    // A backup is the size of the whole evidence tree; copying it synchronously would stall the
    // status server for exactly as long as the streamed verification above avoided stalling it.
    await fs.promises.mkdir(this.uploadsDir, { recursive: true });
    await fs.promises.copyFile(uploadPath, archivePath);
```

Leave every other `fs.rmSync` in this file alone: they delete single small files on failure paths, and making them async would widen this task without benefit.

- [ ] **Step 2: Verify**

Run: `npm run build:test && npm run test -- assistant-backup-restore assistant-gate-e`
Expected: `fail 0`.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/assistant/control/restore-service.ts
git commit -m "perf(assistant): copy a parked restore upload without blocking the event loop"
```

---

### Task 3: `findEocdOffset` throws instead of signalling (finding 9)

A `-1` sentinel with exactly one caller that must remember to check it. Every other codec in `zip.ts` throws.

**Files:**
- Modify: `src/lib/zip.ts` (`findEocdOffset`), `src/lib/zip-file-reader.ts` (its caller)

- [ ] **Step 1: Throw from the codec**

In `src/lib/zip.ts`, replace:

```ts
/** Offset of the EOCD record inside `tail`, or -1 when the tail holds no archive end. */
export function findEocdOffset(tail: Buffer): number {
  for (let index = tail.byteLength - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) return index;
  }
  return -1;
}
```

with:

```ts
/** Offset of the EOCD record inside `tail`. Throws when the tail holds no archive end. */
export function findEocdOffset(tail: Buffer): number {
  for (let index = tail.byteLength - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) return index;
  }
  throw new Error('Zip end of central directory not found.');
}
```

- [ ] **Step 2: Drop the caller's check**

In `src/lib/zip-file-reader.ts`, replace:

```ts
  const eocdOffset = findEocdOffset(tail);
  if (eocdOffset < 0) throw new Error('Zip end of central directory not found.');
```

with:

```ts
  const eocdOffset = findEocdOffset(tail);
```

- [ ] **Step 3: Verify the message survives**

Run: `npm run build:test && npm run test -- zip`
Expected: `fail 0`. Two tests assert on this text — `rejects non-zip input` in `tests/zip.test.ts` (`/end of central directory/iu`) and `ZipFileReader rejects a file that is not a zip` in `tests/zip-file-reader.test.ts` (`/end of central directory not found/u`) — so a changed wording fails here.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/zip.ts src/lib/zip-file-reader.ts
git commit -m "refactor(lib): findEocdOffset throws instead of returning a sentinel"
```

---

### Task 4: One async read path in `ZipFileReader` (findings 10 and 3)

The reader currently has two read modes over one handle — a synchronous `readExactly(fd, …)` reached through a `private get fd()`, and an async one — with near-duplicate short-read handling in each. The `fd` getter exists only so the pre-existing sync call sites kept compiling; that is an incomplete migration, and it is why the class doc's "a multi-gigabyte restore cannot stall the status server" is false for `readEntry`.

Deleting the sync mode makes `readEntry` async, which cascades to `readManifestOnly`, `readManifest` and `recoverKey` — and makes the doc true rather than needing to be watered down.

**Files:**
- Modify: `src/lib/zip-file-reader.ts` (whole read path), `src/assistant/control/restore-service.ts:161-194`, `:264-266`
- Test: `tests/helpers/archive-bytes.ts`, `tests/zip-file-reader.test.ts`, `tests/zip.test.ts`

- [ ] **Step 1: Replace the module-level reader helpers**

In `src/lib/zip-file-reader.ts`, replace the synchronous `readExactly` and `readCentralDirectory` with:

```ts
/** A short read means the archive is truncated, which must never be mistaken for zero bytes. */
async function readExactly(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error('Zip archive ended before the expected number of bytes.');
    read += bytesRead;
  }
}

async function readCentralDirectory(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<Map<string, DirectoryEntry>> {
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT_LENGTH);
  const tail = Buffer.alloc(tailLength);
  await readExactly(handle, tail, tailLength, size - tailLength);

  const eocdOffset = findEocdOffset(tail);
  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralStart = tail.readUInt32LE(eocdOffset + 16);
  const central = Buffer.alloc(centralSize);
  await readExactly(handle, central, centralSize, centralStart);

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
}
```

- [ ] **Step 2: Make the class single-mode**

Replace the class doc, delete `private get fd()`, and make the read path async:

```ts
/**
 * Reads entries of an on-disk archive without loading the archive into memory. The central
 * directory is parsed once — it is small — and payloads are read on demand. Every read goes
 * through the handle's promise API, so no read blocks the event loop, and every read is
 * CRC-verified.
 *
 * Two bounded exceptions remain, both CPU rather than I/O: a deflated entry is inflated in a
 * single synchronous call, and an in-memory read folds its CRC in one pass. `ZipFileWriter` only
 * deflates `addBuffer` entries, so in a backup those are the manifest and the sealed key.
 */
export class ZipFileReader {
  private constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly directory: ReadonlyMap<string, DirectoryEntry>,
  ) {}

  static async open(archivePath: string): Promise<ZipFileReader> {
    const handle = await fs.promises.open(archivePath, 'r');
    try {
      const { size } = await handle.stat();
      return new ZipFileReader(handle, await readCentralDirectory(handle, size));
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
```

`entryNames`, `hasEntry`, `entrySize` and `requireEntry` read only the parsed directory and stay synchronous — leave them exactly as they are.

Replace `readEntry`, and the two private helpers:

```ts
  /** In-memory read for metadata-sized entries; CRC-verified. */
  async readEntry(name: string): Promise<Buffer> {
    const entry = this.requireEntry(name);
    const compressed = await this.readRange(await this.dataStart(entry), entry.compressedSize);
    const data = entry.method === 8 ? inflateRawSync(compressed) : compressed;
    if (crc32(data) !== entry.crc) {
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
    return data;
  }
```

```ts
  private async readRange(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    await readExactly(this.handle, buffer, length, position);
    return buffer;
  }

  /** The local header repeats the name and extra fields, so the payload offset comes from it. */
  private async dataStart(entry: DirectoryEntry): Promise<number> {
    return localHeaderDataOffset(
      entry.localOffset,
      await this.readRange(entry.localOffset, LOCAL_HEADER_SIZE),
    );
  }
```

Delete `private async readExactlyAsync(...)` entirely — the module-level `readExactly` replaces it.

- [ ] **Step 3: Point the remaining internals at the async path**

In `hashEntry`:

```ts
    if (entry.method !== 0) {
      return createHash('sha256').update(await this.readEntry(name)).digest('hex');
    }
```

In `extractTo`:

```ts
    if (entry.method !== 0) {
      await fs.promises.writeFile(destinationPath, await this.readEntry(name));
      return;
    }
```

In `walkStored`, take the offset asynchronously and use the module helper:

```ts
  private async walkStored(name: string, entry: DirectoryEntry, sink: ChunkSink): Promise<void> {
    const start = await this.dataStart(entry);
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let crc = CRC32_SEED;
    let position = 0;
    while (position < entry.compressedSize) {
      const toRead = Math.min(READ_CHUNK_BYTES, entry.compressedSize - position);
      await readExactly(this.handle, chunk, toRead, start + position);
      const view = chunk.subarray(0, toRead);
      crc = crc32Update(crc, view);
      await sink.write(view);
      position += toRead;
    }
    if (crc32Finish(crc) !== entry.crc) {
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
  }
```

- [ ] **Step 4: Cascade through `RestoreService`**

Replace `readManifestOnly` and `readManifest` (`src/assistant/control/restore-service.ts:179-194`):

```ts
  private async readManifestOnly(reader: ZipFileReader): Promise<BackupManifest> {
    if (!reader.hasEntry(MANIFEST_ENTRY)) throw new Error('Backup is missing its manifest.json.');
    return parseJsonText(
      (await reader.readEntry(MANIFEST_ENTRY)).toString('utf8'),
      BackupManifestSchema,
    );
  }

  private async readManifest(reader: ZipFileReader): Promise<BackupManifest> {
    const manifest = await this.readManifestOnly(reader);
    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Backup schema version ${manifest.schemaVersion} is newer than this build's `
        + `${CURRENT_SCHEMA_VERSION}; upgrade SiftKit before restoring.`,
      );
    }
    if (!reader.hasEntry(SNAPSHOT_ENTRY)) throw new Error('Backup is missing its database snapshot.');
    return manifest;
  }
```

In `verifyEntries` (`:163`): `const manifest = await this.readManifestOnly(reader);`

In `preview` (`:85`): `manifest = await this.readManifest(reader);`

In `confirm` (`:128`): `await this.readManifest(reader);`

In `recoverKey` (`:266`): `const sealed = await reader.readEntry(KEY_ENTRY);`

- [ ] **Step 5: Cascade through the tests**

`tests/helpers/archive-bytes.ts:44`:

```ts
      entries.set(name, await reader.readEntry(name));
```

`tests/zip-file-reader.test.ts`:
- `:41` → `assert.equal((await reader.readEntry('manifest.json')).toString('utf8'), MANIFEST_TEXT);`
- `:82` → `assert.deepEqual(await reader.readEntry('compressible.txt'), compressible);`
- `:95` → `await assert.rejects(reader.readEntry('nope.txt'), /no entry named nope\.txt/u);`

`tests/zip.test.ts:54` → `await assert.rejects(reader.readEntry('a.bin'), /CRC/u);`

Note `entrySize('nope.txt')` on the line after `:95` stays `assert.throws` — `entrySize` is still synchronous.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run typecheck`
Expected: clean. A missed `await` shows up here as `Promise<Buffer>` where `Buffer` is required.

Run: `npm run build:test && npm run test -- zip assistant`
Expected: `fail 0`, including the existing `ZipFileReader yields to the event loop while extracting` test.

- [ ] **Step 7: Confirm the sync path is gone**

Run: `git grep -n "readSync\|get fd()\|readExactlyAsync" -- src/lib`
Expected: no matches. Any hit means the migration is partial — the exact condition this task exists to remove.

- [ ] **Step 8: Commit**

```bash
git add src/lib/zip-file-reader.ts src/assistant/control/restore-service.ts tests/helpers/archive-bytes.ts tests/zip-file-reader.test.ts tests/zip.test.ts
git commit -m "refactor(lib): one async read path in ZipFileReader"
```

---

### Task 5: `finish()` returns a narrow handle (finding 7)

`finish()` returns `this`, so a caller holding a `TempArchive` still reaches `writer` and `scratchPath` at runtime — `sendArchive` could call `archive.writer.addBuffer` on a sealed archive. The type narrows; the object does not.

**Files:**
- Modify: `src/assistant/control/temp-archive.ts`
- Test: `tests/assistant-archive-streaming.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/assistant-archive-streaming.test.ts`:

```ts
test('the finished handle exposes only the path and cleanup', () => {
  const builder = new TempArchiveBuilder('siftkit-archive-narrow-');
  builder.writer.addBuffer('payload.bin', Buffer.from('sealed', 'utf8'));
  const archive = builder.finish();

  assert.deepEqual(Object.keys(archive).sort(), ['cleanup', 'path']);
  assert.equal('writer' in archive, false, 'a sealed archive must not hand back its writer');
  assert.equal('scratchPath' in archive, false);
  archive.cleanup();
  assert.equal(fs.existsSync(path.dirname(archive.path)), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test && npm run test -- assistant-archive-streaming`
Expected: FAIL — `Object.keys` on the builder instance yields `writer`, `path` and more, so the `deepEqual` fails before the `in` checks.

- [ ] **Step 3: Return a bound handle**

In `src/assistant/control/temp-archive.ts`, drop `implements TempArchive`, make the archive path private again, and bind the handle to the single `cleanup`:

```ts
export class TempArchiveBuilder {
  readonly writer: ZipFileWriter;
  private readonly directory: string;
  private readonly archivePath: string;
  private finished = false;

  constructor(prefix: string) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.archivePath = path.join(this.directory, ARCHIVE_FILE_NAME);
    this.writer = new ZipFileWriter(this.archivePath);
  }

  /** A path for an intermediate file, inside the directory `cleanup` already covers. */
  scratchPath(name: string): string {
    return path.join(this.directory, name);
  }

  /**
   * Seals the archive and hands back a handle carrying only what a caller streaming it needs.
   * `cleanup` is the builder's own, so there is still exactly one cleanup implementation.
   */
  finish(): TempArchive {
    this.writer.finish();
    this.finished = true;
    return { path: this.archivePath, cleanup: (): void => this.cleanup() };
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
Expected: `fail 0`. The existing `the builder and the archive it returns share one cleanup` test still passes — both routes call the same method.

Run: `npm run typecheck`
Expected: clean. Nothing outside this file read `builder.path`; if something does, it surfaces here.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/temp-archive.ts tests/assistant-archive-streaming.test.ts
git commit -m "refactor(assistant): a sealed temp archive hands back only path and cleanup"
```

---

### Task 6: Say only what the external-tool test can detect (finding 4)

The assertion message claims a cleared UTF-8 flag bit is what it catches. Mutation testing during the previous plan proved otherwise: clearing `0x0800` fails nothing, because .NET decodes entry names as UTF-8 regardless. The comment above it makes the same false claim. A misleading message is worse than none.

**Files:**
- Modify: `tests/zip-external-tool.test.ts:27-28`, `:44-48`

- [ ] **Step 1: Replace the false comment**

Replace:

```ts
  // A non-ASCII name is the only way the UTF-8 flag bit is observable: our own reader decodes
  // names as UTF-8 unconditionally, so clearing the bit is invisible to every other test.
```

with:

```ts
  // Carried for the other tools users open these archives with. Note what this does NOT prove:
  // clearing the UTF-8 flag bit (0x0800) fails nothing here, because .NET decodes entry names as
  // UTF-8 regardless — as does our own reader. No available oracle can pin that bit.
```

- [ ] **Step 2: Replace the false assertion message**

Replace:

```ts
  assert.equal(
    fs.readFileSync(path.join(outDir, ...UNICODE_ENTRY.split('/')), 'utf8'),
    'naïve',
    'a cleared UTF-8 flag bit makes Windows decode the name in the OEM codepage',
  );
```

with:

```ts
  assert.equal(fs.readFileSync(path.join(outDir, ...UNICODE_ENTRY.split('/')), 'utf8'), 'naïve');
```

- [ ] **Step 3: Record what the oracle does cover**

Extend the test's doc comment:

```ts
/**
 * The module doc for `src/lib/zip.ts` promises archives that Windows can open without SiftKit's
 * own reader. `ZipFileReader` cannot prove that — only a foreign unzip can. This is the
 * independent oracle that used to be `readZip`.
 *
 * Mutation-verified: corrupting the EOCD central-directory offset fails this test. It does not
 * cover CRC — Expand-Archive does not verify stored entries, and every entry this writer emits is
 * stored — so `zip.test.ts` owns the CRC case.
 */
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && npm run test -- zip-external-tool`
Expected on Windows: `pass 1`, `fail 0`.

- [ ] **Step 5: Re-confirm the oracle still bites**

Temporarily change `eocd.writeUInt32LE(centralStart, 16)` to `eocd.writeUInt32LE(centralStart + 1, 16)` in `encodeEocd` (`src/lib/zip.ts`).

Run: `npm run build:test && npm run test -- zip-external-tool`
Expected: FAIL.

Restore the line, re-run, and confirm `git status --short -- src` lists nothing of ours.

- [ ] **Step 6: Commit**

```bash
git add tests/zip-external-tool.test.ts
git commit -m "test(lib): state only what the external unzip oracle can detect"
```

---

### Task 7: Drop the duplicated token assertions (finding 5)

Four assertions repeated verbatim inside and after the poll. If the poll returned, the copies hold by construction.

**Files:**
- Modify: `tests/dashboard-status-server.test.ts:3158-3161`

- [ ] **Step 1: Delete the post-poll copies**

Remove these four lines, leaving the identical assertions inside the `waitForAsyncExpectation` block and the `assert.notEqual(capturedChatRawBody, '')` line that follows:

```ts
    assert.equal(Number(statusMetrics.inputTokensTotal) >= 20, true);
    assert.equal(Number(statusMetrics.outputTokensTotal) >= 4, true);
    assert.equal(Number(d(d(statusMetrics.taskTotals).chat).inputTokensTotal) >= 20, true);
    assert.equal(Number(d(d(statusMetrics.taskTotals).chat).outputTokensTotal) >= 4, true);
```

`statusMetrics` is still assigned inside the poll and read further down, so its declaration stays.

- [ ] **Step 2: Verify**

Run: `npm run build:test && npm run test -- dashboard-status-server`
Expected: `pass 42`, `fail 0`.

Run: `npm run typecheck`
Expected: clean — `statusMetrics` must still be read after the poll, so an over-eager deletion surfaces as an unused-variable lint error.

- [ ] **Step 3: Commit**

```bash
git add tests/dashboard-status-server.test.ts
git commit -m "test(dashboard): drop assertions the poll already guarantees"
```

---

### Task 8: Final gate

- [ ] **Step 1: Typecheck and lint**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full suite**

Run: `npm run build:test && npm run test`
Expected: `fail 0`, `skipped 2`, total 3255 (baseline 3253 plus Task 1's ordering guard and Task 5's narrow-handle test).

If `dashboard-status-server` or `assistant-gate-d-e2e` fails or parks, re-run once before investigating — see **Preconditions**.

- [ ] **Step 3: Confirm the removed shapes are gone**

Run: `git grep -n "get fd()\|readExactlyAsync\|writeSync\|copyFileSync" -- src/lib src/assistant/control src/status-server/http-utils.ts`
Expected: no matches.

Run: `git grep -n "return -1" -- src/lib/zip.ts`
Expected: no matches.

- [ ] **Step 4: Verify the unrelated user work is untouched**

Run: `git status --short`
Expected: exactly the paths listed under **Preconditions**, and nothing else.

- [ ] **Step 5: Update the reflection record**

Append a short section to `docs/superpowers/plans/2026-08-16-scalability-refactors-HANDOFF.md` under the drift-remediation heading recording that findings 1, 2, 3, 4, 5, 7, 9 and 10 are closed, and that findings 6 and 8 were reviewed and deliberately left:

- 6 — `readArchiveEntriesFromBytes` still round-trips bytes through a temp file; accepted because it is test-only and the alternative is a second reader.
- 8 — `BufferBodySink.take()` keeps its unreachable-state throw; accepted because the nullable field is what makes the sink's two-phase contract type-safe.

```bash
git add docs/superpowers/plans/2026-08-16-scalability-refactors-HANDOFF.md
git commit -m "docs: record the drift follow-up outcome"
```

---

## Self-review notes

- **Coverage:** findings 1 (Task 1), 2 (Task 2), 9 (Task 3), 10 + 3 (Task 4), 7 (Task 5), 4 (Task 6), 5 (Task 7). Task 8 is the gate. Findings 6 and 8 are excluded by the user and explicitly recorded in Task 8 Step 5 so the omission is deliberate, not forgotten.
- **Ordering constraints:** Task 3 must precede Task 4 — Task 4 rewrites `readCentralDirectory` and would otherwise reintroduce the sentinel check. Task 1 must precede Task 8's `writeSync` grep. Everything else is independent.
- **Type consistency:** `BodySink.write/close/discard` all return `Promise<void>` after Task 1 — `BufferBodySink.take()` stays synchronous and is unchanged. `ZipFileReader.readEntry` returns `Promise<Buffer>` after Task 4; `entryNames`/`hasEntry`/`entrySize` stay synchronous throughout, which is why `entrySize('nope.txt')` keeps `assert.throws` while `readEntry('nope.txt')` moves to `assert.rejects`. `TempArchive` keeps its existing `{ path, cleanup }` shape — Task 5 changes only what `finish()` returns, not the interface.
- **Known risk:** Task 1 is the only task that changes runtime concurrency, and it sits on every route's request path. If unrelated route tests fail after it, suspect a missed `resume()` (a request paused and never resumed hangs until the socket times out) before suspecting the sinks.
- **Honest labelling:** Task 1 Step 3 and Task 5 Step 2 differ — Task 5 is a genuine red-green, Task 1's new test passes before the change and is justified as a guard for newly-introduced concurrency, with Step 7 proving it is load-bearing. Task 2, 3 and 7 are refactors under existing coverage with no new test, which is stated rather than dressed up.
