import { readSummaryInput, summarizeRequest } from '../summary/core.js';
import { getCommandArgs, parseArguments } from './args.js';

export async function runSummary(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const question = parsed.question || parsed.positionals[0];
  if (!question) {
    throw new Error('A question is required.');
  }

  const inputText = readSummaryInput({
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
  const result = await summarizeRequest({
    question,
    inputText: inputText ?? '',
    format: parsed.format === 'json' ? 'json' : 'text',
    policyProfile: (parsed.profile as Parameters<typeof summarizeRequest>[0]['policyProfile']) || 'general',
    backend: parsed.backend,
    model: parsed.model,
    sourceKind: process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || hasStdinInput
      ? 'command-output'
      : 'standalone',
    commandExitCode: process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
      ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
      : undefined,
  });
  options.stdout.write(`${result.Summary}\n`);
  return 0;
}
