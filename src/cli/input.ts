import * as fs from 'node:fs';
import { decodeTextBuffer } from '../lib/text-encoding.js';

function normalizeCliInputText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return text.replace(/[\r\n]+$/u, '');
}

export function readCliTextInput(options: {
  text?: string;
  file?: string;
  stdinText?: string | Buffer;
}): string | null {
  if (options.text !== undefined) {
    return normalizeCliInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeCliInputText(
          Buffer.isBuffer(options.stdinText)
            ? decodeTextBuffer(options.stdinText)
            : options.stdinText,
        );
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeCliInputText(decodeTextBuffer(fs.readFileSync(options.file)));
  }

  if (options.stdinText !== undefined) {
    return normalizeCliInputText(
      Buffer.isBuffer(options.stdinText)
        ? decodeTextBuffer(options.stdinText)
        : options.stdinText,
    );
  }

  return null;
}
