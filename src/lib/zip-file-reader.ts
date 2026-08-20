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
 * Reads entries of an on-disk archive without loading the archive into memory. The central
 * directory is parsed once — it is small — and payloads are read on demand. Deflated entries are
 * inflated in memory because only metadata-sized entries are ever deflated by `ZipFileWriter`;
 * stored entries stream a chunk at a time. Every read is CRC-verified, matching `readZip`.
 */
export class ZipFileReader {
  private constructor(
    private readonly fd: number,
    private readonly directory: ReadonlyMap<string, DirectoryEntry>,
  ) {}

  static open(archivePath: string): ZipFileReader {
    const fd = fs.openSync(archivePath, 'r');
    try {
      return new ZipFileReader(fd, readCentralDirectory(fd, fs.statSync(archivePath).size));
    } catch (error) {
      fs.closeSync(fd);
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

  /** In-memory read for metadata-sized entries; CRC-verified like `readZip`. */
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
  hashEntry(name: string): string {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      return createHash('sha256').update(this.readEntry(name)).digest('hex');
    }
    const hash = createHash('sha256');
    this.forEachStoredChunk(name, entry, (chunk) => hash.update(chunk));
    return hash.digest('hex');
  }

  /** Chunked extraction for stored entries; CRC verified over the stream. */
  async extractTo(name: string, destinationPath: string): Promise<void> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      fs.writeFileSync(destinationPath, this.readEntry(name));
      return;
    }
    const out = fs.openSync(destinationPath, 'w');
    let position = 0;
    try {
      this.forEachStoredChunk(name, entry, (chunk) => {
        fs.writeSync(out, chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
      });
    } catch (error) {
      fs.closeSync(out);
      fs.rmSync(destinationPath, { force: true });
      throw error;
    }
    fs.closeSync(out);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  /**
   * Walks a stored entry a chunk at a time and throws unless the CRC matches. `consume` is an
   * inline visitor rather than a returned iterator so the CRC check cannot be skipped by a
   * caller that stops early.
   */
  private forEachStoredChunk(
    name: string,
    entry: DirectoryEntry,
    consume: (chunk: Buffer) => void,
  ): void {
    const start = this.dataStart(entry);
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let crc = CRC32_SEED;
    let position = 0;
    while (position < entry.compressedSize) {
      const toRead = Math.min(READ_CHUNK_BYTES, entry.compressedSize - position);
      readExactly(this.fd, chunk, toRead, start + position);
      const view = chunk.subarray(0, toRead);
      crc = crc32Update(crc, view);
      consume(view);
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
