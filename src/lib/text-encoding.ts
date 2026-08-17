import { readFileSync } from 'node:fs';

export type SupportedTextEncoding = 'utf8' | 'utf16le' | 'utf16be';

export function detectEncoding(buffer: Buffer): SupportedTextEncoding {
  if (buffer.length >= 2) {
    const byte0 = buffer[0];
    const byte1 = buffer[1];
    if (byte0 === 0xff && byte1 === 0xfe) {
      return 'utf16le';
    }
    if (byte0 === 0xfe && byte1 === 0xff) {
      return 'utf16be';
    }
  }

  if (buffer.length < 8) {
    return 'utf8';
  }

  const sampleLength = Math.min(buffer.length, 4096);
  const evenSlots = Math.ceil(sampleLength / 2);
  const oddSlots = Math.floor(sampleLength / 2);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0x00) {
      continue;
    }
    if ((index % 2) === 0) {
      evenNulls += 1;
    } else {
      oddNulls += 1;
    }
  }

  const evenNullRatio = evenSlots > 0 ? (evenNulls / evenSlots) : 0;
  const oddNullRatio = oddSlots > 0 ? (oddNulls / oddSlots) : 0;
  if (oddNullRatio >= 0.4 && evenNullRatio <= 0.1) {
    return 'utf16le';
  }
  if (evenNullRatio >= 0.4 && oddNullRatio <= 0.1) {
    return 'utf16be';
  }
  return 'utf8';
}

export function decodeTextBuffer(buffer: Buffer): string {
  const encoding = detectEncoding(buffer);
  if (encoding === 'utf16le') {
    const content = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
      ? buffer.subarray(2)
      : buffer;
    return content.toString('utf16le');
  }
  if (encoding === 'utf16be') {
    const content = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff
      ? buffer.subarray(2)
      : buffer;
    const evenLength = content.length - (content.length % 2);
    const swapped = Buffer.allocUnsafe(evenLength);
    for (let index = 0; index < evenLength; index += 2) {
      swapped[index] = content[index + 1];
      swapped[index + 1] = content[index];
    }
    return swapped.toString('utf16le');
  }

  const decoded = buffer.toString('utf8');
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

export function readTextFileWithEncoding(filePath: string): string {
  return decodeTextBuffer(readFileSync(filePath));
}

/**
 * Reads a text file and normalizes CRLF to LF. This is the single source-text
 * normalization point: `read`, `edit`, and any future consumer must go through
 * it so the model always sees — and matches against — LF, regardless of the
 * working tree's on-disk line endings.
 */
export function readSourceText(filePath: string): string {
  return readTextFileWithEncoding(filePath).replace(/\r\n/gu, '\n');
}

export type SourceEolStyle = 'lf' | 'crlf';

/**
 * 'crlf' only when the text has at least one newline and every newline is CRLF.
 * Mixed-ending files report 'lf', so write-back normalizes them to uniform LF.
 */
export function detectEolStyle(rawText: string): SourceEolStyle {
  const newlines = rawText.match(/\r?\n/gu) ?? [];
  return newlines.length > 0 && newlines.every((newline) => newline === '\r\n') ? 'crlf' : 'lf';
}

/** Re-applies a detected style to LF-normalized text. Idempotent for either input style. */
export function applyEolStyle(text: string, style: SourceEolStyle): string {
  const normalized = text.replace(/\r\n/gu, '\n');
  return style === 'crlf' ? normalized.replace(/\n/gu, '\r\n') : normalized;
}
