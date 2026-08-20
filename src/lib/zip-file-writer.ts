import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import {
  CRC32_SEED, LOCAL_HEADER_CRC_OFFSET,
  crc32, crc32Finish, crc32Update,
  encodeCentralHeader, encodeEocd, encodeLocalHeader,
} from './zip.js';

const READ_CHUNK_BYTES = 1024 * 1024;
/** Sizes and offsets are 32-bit: this writer emits no zip64 records. */
const MAX_ZIP32_BYTES = 0xfffffffe;

interface WrittenEntry {
  readonly name: Buffer;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
  crc: number;
}

/**
 * Streams a zip archive to disk entry by entry, holding at most one read chunk in memory.
 * Zero timestamps for determinism, UTF-8 names, no zip64 -- see `zip.ts` for the header codecs.
 *
 * File entries are STORE (method 0), so their sizes are known from `stat` before any byte is
 * written. Only the CRC is not, and rather than reading the source twice — or emitting a data
 * descriptor that older readers mishandle — the local header goes out with a zero CRC and the
 * four-byte field is patched in place once the copy completes. Every write is positional, so
 * patching an earlier header never disturbs where the next entry lands.
 */
export class ZipFileWriter {
  private readonly fd: number;
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private finished = false;
  private aborted = false;

  constructor(private readonly archivePath: string) {
    this.fd = fs.openSync(archivePath, 'w');
  }

  /** Small metadata entries (manifest, key blob): in-memory add, deflated when it helps. */
  addBuffer(name: string, data: Buffer): void {
    this.assertWritable();
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.byteLength < data.byteLength;
    const payload = useDeflate ? deflated : data;
    this.writeEntryHeaderAndName(
      name, crc32(data), useDeflate ? 8 : 0, payload.byteLength, data.byteLength,
    );
    this.append(payload);
  }

  /** Streams an on-disk file as a STORE entry, one chunk at a time. */
  async addFile(name: string, sourcePath: string): Promise<void> {
    this.assertWritable();
    const size = fs.statSync(sourcePath).size;
    this.assertZip32(size, `File ${sourcePath} is too large for a non-zip64 archive.`);
    const headerOffset = this.offset;
    this.writeEntryHeaderAndName(name, 0, 0, size, size);
    const entry = this.entries[this.entries.length - 1];
    entry.crc = await this.copyFileContents(sourcePath, size);
    this.writeAt(headerOffset + LOCAL_HEADER_CRC_OFFSET, uint32(entry.crc));
  }

  /** Writes the central directory and closes the archive. */
  finish(): void {
    this.assertWritable();
    this.finished = true;
    try {
      const centralStart = this.offset;
      for (const entry of this.entries) {
        this.writeCentralHeader(entry);
      }
      this.assertZip32(this.offset, 'Archive is too large for a non-zip64 end-of-central-directory.');
      this.append(encodeEocd(this.entries.length, this.offset - centralStart, centralStart));
    } finally {
      fs.closeSync(this.fd);
    }
  }

  /**
   * Closes and deletes a half-written archive. Idempotent, and safe after `finish`, so the
   * caller can put one `abort` in a failure path without tracking how far writing got.
   */
  abort(): void {
    if (!this.finished && !this.aborted) {
      fs.closeSync(this.fd);
    }
    this.aborted = true;
    fs.rmSync(this.archivePath, { force: true });
  }

  private assertWritable(): void {
    if (this.finished) throw new Error('Zip archive already finished.');
    if (this.aborted) throw new Error('Zip archive already aborted.');
  }

  private assertZip32(value: number, message: string): void {
    if (value > MAX_ZIP32_BYTES) throw new Error(message);
  }

  /** The only place bytes are appended, so `offset` and the file can never disagree. */
  private append(data: Buffer): void {
    this.writeAt(this.offset, data);
    this.offset += data.byteLength;
  }

  private writeAt(position: number, data: Buffer): void {
    fs.writeSync(this.fd, data, 0, data.byteLength, position);
  }

  private writeCentralHeader(entry: WrittenEntry): void {
    this.append(encodeCentralHeader(entry, entry.offset));
    this.append(entry.name);
  }

  private writeEntryHeaderAndName(
    name: string, crc: number, method: 0 | 8, compressedSize: number, uncompressedSize: number,
  ): void {
    const nameBytes = Buffer.from(name, 'utf8');
    const fields = { name: nameBytes, method, crc, compressedSize, uncompressedSize };
    this.entries.push({ ...fields, offset: this.offset });
    this.append(encodeLocalHeader(fields));
    this.append(nameBytes);
  }

  /** Copies the source into the archive a chunk at a time and returns its CRC. */
  private async copyFileContents(sourcePath: string, size: number): Promise<number> {
    const source = await fs.promises.open(sourcePath, 'r');
    let crc = CRC32_SEED;
    let copied = 0;
    try {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      for (;;) {
        const read = await source.read(chunk, 0, READ_CHUNK_BYTES, null);
        if (read.bytesRead === 0) break;
        const view = chunk.subarray(0, read.bytesRead);
        crc = crc32Update(crc, view);
        this.append(view);
        copied += read.bytesRead;
      }
    } finally {
      await source.close();
    }
    if (copied !== size) {
      throw new Error(`File ${sourcePath} changed size while being archived; the archive is unusable.`);
    }
    return crc32Finish(crc);
  }
}

function uint32(value: number): Buffer {
  const field = Buffer.alloc(4);
  field.writeUInt32LE(value, 0);
  return field;
}
