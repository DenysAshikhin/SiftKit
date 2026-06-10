import { getCommandArgs, parseArguments } from './args.js';
import { readCliTextInput } from './input.js';
import { normalizeCliFormat } from './request-normalizers.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runPresetCli(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const presetId = String(parsed.preset || '').trim();
  if (!presetId) {
    throw new Error('A --preset is required.');
  }

  const inputText = readCliTextInput({
    text: parsed.text,
    file: parsed.file,
    stdinText: options.stdinText,
  });
  const hasStdinInput = typeof options.stdinText === 'string'
    ? options.stdinText.trim().length > 0
    : Buffer.isBuffer(options.stdinText)
      ? options.stdinText.length > 0
      : false;
  const commandExitCode = process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
    ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
    : undefined;
  const result = await new StatusServerApiClient().runPreset({
    presetId,
    prompt: String(parsed.prompt || parsed.positionals.join(' ')).trim() || undefined,
    question: parsed.question || parsed.positionals[0],
    inputText: inputText ?? undefined,
    format: normalizeCliFormat(parsed.format),
    backend: parsed.backend,
    model: parsed.model,
    profile: parsed.profile,
    sourceKind: process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || hasStdinInput
      ? 'command-output'
      : 'standalone',
    commandExitCode,
    repoRoot: String(parsed.repoRoot || parsed.path || process.cwd()).trim() || process.cwd(),
    maxTurns: Number.isFinite(parsed.maxTurns) && Number(parsed.maxTurns) > 0 ? Number(parsed.maxTurns) : undefined,
    logFile: parsed.logFile,
  });
  options.stdout.write(`${result.outputText}\n`);
  return 0;
}
