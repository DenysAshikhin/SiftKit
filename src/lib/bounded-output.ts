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
