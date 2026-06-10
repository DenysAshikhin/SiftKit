import type { SummaryRequest, SummaryTimingInput } from '../summary/types.js';
import { getCommandArgs, parseArguments } from './args.js';
import { readCliTextInput } from './input.js';
import { normalizeCliFormat, normalizeCliPolicyProfileOrDefault } from './request-normalizers.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runSummary(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
  timing?: SummaryTimingInput;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const question = parsed.question || parsed.positionals[0];
  if (!question) {
    throw new Error('A question is required.');
  }

  const inputText = readCliTextInput({
    text: parsed.text,
    file: parsed.file,
    stdinText: options.stdinText,
  });
  if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim()) {
    throw new Error('stdin, --text or --file required');
  }

  const hasStdinInput = typeof options.stdinText === 'string'
    ? options.stdinText.trim().length > 0
    : Buffer.isBuffer(options.stdinText)
      ? options.stdinText.length > 0
      : false;
  const sourceKind = process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || hasStdinInput
    ? 'command-output'
    : 'standalone';
  const commandExitCode = process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
    ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
    : undefined;
  const request: SummaryRequest = {
    question,
    inputText: inputText ?? '',
    format: normalizeCliFormat(parsed.format),
    policyProfile: normalizeCliPolicyProfileOrDefault(parsed.profile),
    backend: parsed.backend,
    model: parsed.model,
    sourceKind,
    commandExitCode,
    timing: options.timing,
  };
  const result = await new StatusServerApiClient().requestSummary(request);
  options.stdout.write(`${result.Summary}\n`);
  return 0;
}
