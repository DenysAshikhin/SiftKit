/**
 * Minimal zip container (PKWARE APPNOTE): methods 0 (store) and 8 (deflate), no zip64.
 * Dependency-free on purpose — the assistant export and backup archives must be readable by
 * Windows Explorer and `Expand-Archive` without SiftKit shipping a compression library.
 *
 * This module owns the format only: constants, CRC32, and the header codecs. `ZipFileWriter`
 * and `ZipFileReader` are the sole writer and reader built on it.
 */

export const LOCAL_HEADER = 0x04034b50;
export const CENTRAL_HEADER = 0x02014b50;
export const EOCD = 0x06054b50;
export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
/** Offset of the CRC field inside a local file header, patched by the streaming writer. */
export const LOCAL_HEADER_CRC_OFFSET = 14;
/** The zip comment field is 16-bit, so the EOCD cannot start further back than this. */
export const MAX_COMMENT_LENGTH = 65_535;

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

/** The seed a chunked CRC pass starts from; feed it to `crc32Update`, then `crc32Finish`. */
export const CRC32_SEED = 0xffffffff;

/** Folds one more chunk into a running CRC. Byte-for-byte identical to a single-buffer `crc32`. */
export function crc32Update(crc: number, data: Buffer): number {
  let next = crc;
  for (const byte of data) {
    next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

export function crc32Finish(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Buffer): number {
  return crc32Finish(crc32Update(CRC32_SEED, data));
}

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
  header.writeUInt16LE(0x0800, 8); // UTF-8 names
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(0, 12); // dos time/date: zero, deterministic
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

/** Offset of the EOCD record inside `tail`. Throws when the tail holds no archive end. */
export function findEocdOffset(tail: Buffer): number {
  for (let index = tail.byteLength - EOCD_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) return index;
  }
  throw new Error('Zip end of central directory not found.');
}

/** Payload offset for an entry, read out of its local header (name and extra repeat there). */
export function localHeaderDataOffset(localOffset: number, localHeader: Buffer): number {
  return localOffset + LOCAL_HEADER_SIZE + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
}
