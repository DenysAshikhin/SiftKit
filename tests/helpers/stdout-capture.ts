export class OutputCapture {
  readonly lines: readonly string[];
  private readonly collectedLines: string[] = [];
  private readonly originalWrite: NodeJS.WriteStream['write'];
  private buffer = '';
  private restored = false;

  private constructor(private readonly stream: NodeJS.WriteStream) {
    this.lines = this.collectedLines;
    this.originalWrite = stream.write.bind(stream);
    stream.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      this.collect(chunk);
      if (typeof encodingOrCallback === 'function') {
        return this.originalWrite(chunk, encodingOrCallback);
      }
      return this.originalWrite(chunk, encodingOrCallback, callback);
    };
  }

  static start(stream: NodeJS.WriteStream): OutputCapture {
    return new OutputCapture(stream);
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (this.buffer.trim()) {
      this.collectedLines.push(this.buffer.trim());
    }
    this.buffer = '';
    this.stream.write = this.originalWrite;
  }

  private collect(chunk: string | Uint8Array): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const parts = this.buffer.split(/\r?\n/u);
    this.buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim()) this.collectedLines.push(line);
    }
  }
}
