import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import {
  CRC32_SEED, EOCD_SIZE, LOCAL_HEADER_SIZE, MAX_COMMENT_LENGTH,
  crc32, crc32Finish, crc32Update,
  decodeCentralHeader, findEocdOffset, localHeaderDataOffset,
} from './zip.js';

const READ_CHUNK_BYTES = 1024 * 1024;

interface DirectoryEntry {
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

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

  entryNames(): string[] {
    return [...this.directory.keys()];
  }

  hasEntry(name: string): boolean {
    return this.directory.has(name);
  }

  /** Uncompressed size, so callers can report totals without reading anything. */
  entrySize(name: string): number {
    return this.requireEntry(name).uncompressedSize;
  }

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

  /** sha256 of the uncompressed entry, computed chunk by chunk for stored entries. */
  async hashEntry(name: string): Promise<string> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      return createHash('sha256').update(await this.readEntry(name)).digest('hex');
    }
    const sink = new HashChunkSink();
    await this.walkStored(name, entry, sink);
    return sink.digest();
  }

  /** Chunked extraction for stored entries; CRC verified over the stream. */
  async extractTo(name: string, destinationPath: string): Promise<void> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      await fs.promises.writeFile(destinationPath, await this.readEntry(name));
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

  async close(): Promise<void> {
    await this.handle.close();
  }

  /** Walks a stored entry a chunk at a time and throws unless the CRC matches. */
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

  private requireEntry(name: string): DirectoryEntry {
    const entry = this.directory.get(name);
    if (entry === undefined) throw new Error(`Zip archive has no entry named ${name}.`);
    return entry;
  }

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
}

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
