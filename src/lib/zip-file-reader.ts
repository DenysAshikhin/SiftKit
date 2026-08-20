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
 * directory is parsed once — it is small — and payloads are read on demand. Deflated entries are
 * inflated in memory because only metadata-sized entries are ever deflated by `ZipFileWriter`;
 * stored entries stream a chunk at a time, off the event loop. Every read is CRC-verified.
 *
 * The handle backs both access modes: `handle.fd` serves the small positional reads that build
 * the directory, while the chunked walks go through the promise API so a multi-gigabyte restore
 * cannot stall the status server.
 */
export class ZipFileReader {
  private constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly directory: ReadonlyMap<string, DirectoryEntry>,
  ) {}

  private get fd(): number {
    return this.handle.fd;
  }

  static async open(archivePath: string): Promise<ZipFileReader> {
    const handle = await fs.promises.open(archivePath, 'r');
    try {
      const { size } = await handle.stat();
      return new ZipFileReader(handle, readCentralDirectory(handle.fd, size));
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
  readEntry(name: string): Buffer {
    const entry = this.requireEntry(name);
    const compressed = this.readRange(this.dataStart(entry), entry.compressedSize);
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

  async close(): Promise<void> {
    await this.handle.close();
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

  /** The async twin of `readExactly`: a short read still means a truncated archive. */
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

  private requireEntry(name: string): DirectoryEntry {
    const entry = this.directory.get(name);
    if (entry === undefined) throw new Error(`Zip archive has no entry named ${name}.`);
    return entry;
  }

  private readRange(position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    readExactly(this.fd, buffer, length, position);
    return buffer;
  }

  /** The local header repeats the name and extra fields, so the payload offset comes from it. */
  private dataStart(entry: DirectoryEntry): number {
    return localHeaderDataOffset(
      entry.localOffset,
      this.readRange(entry.localOffset, LOCAL_HEADER_SIZE),
    );
  }
}

/** A short read means the archive is truncated, which must never be mistaken for zero bytes. */
function readExactly(fd: number, buffer: Buffer, length: number, position: number): void {
  let read = 0;
  while (read < length) {
    const bytes = fs.readSync(fd, buffer, read, length - read, position + read);
    if (bytes === 0) throw new Error('Zip archive ended before the expected number of bytes.');
    read += bytes;
  }
}

function readCentralDirectory(fd: number, size: number): Map<string, DirectoryEntry> {
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT_LENGTH);
  const tail = Buffer.alloc(tailLength);
  readExactly(fd, tail, tailLength, size - tailLength);

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
}
