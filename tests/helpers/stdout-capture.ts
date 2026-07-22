/**
 * Captures whole lines written to stdout while `fn` runs, then restores the
 * original writer. Lines are still forwarded to the real stdout so a failing
 * test keeps its diagnostic output.
 */
export async function captureStdoutLines(fn: () => Promise<void>): Promise<string[]> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  let buffer = '';
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) lines.push(line);
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  if (buffer.trim()) lines.push(buffer.trim());
  return lines;
}
