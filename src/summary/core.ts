import * as fs from 'node:fs';
import { decodeTextBuffer } from '../lib/text-encoding.js';
import { normalizeInputText } from './measure.js';
import { SummaryRequestRunner } from './request-runner.js';
import type {
  SummaryRequest,
  SummaryResult,
} from './types.js';

export async function summarizeRequest(request: SummaryRequest): Promise<SummaryResult> {
  return new SummaryRequestRunner(request).run();
}

export function readSummaryInput(options: {
  text?: string;
  file?: string;
  stdinText?: string | Buffer;
}): string | null {
  if (options.text !== undefined) {
    return normalizeInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeInputText(
          Buffer.isBuffer(options.stdinText)
            ? decodeTextBuffer(options.stdinText)
            : options.stdinText,
        );
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeInputText(decodeTextBuffer(fs.readFileSync(options.file)));
  }

  if (options.stdinText !== undefined) {
    return normalizeInputText(
      Buffer.isBuffer(options.stdinText)
        ? decodeTextBuffer(options.stdinText)
        : options.stdinText,
    );
  }

  return null;
}
