import type { SummaryRequest, SummaryTimingInput } from '../summary/types.js';
import { parseArguments, type ResolvedCliArgs } from './args.js';
import { readCliTextInput } from './input.js';
import { normalizeCliFormat, normalizeCliPolicyProfileOrDefault } from './request-normalizers.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';
import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';
import { getActiveModelPreset, loadConfig } from '../config/index.js';
import { resolveImageTokenBudget } from '../llm-protocol/image-token-budget.js';

export async function runSummary(options: ResolvedCliArgs & {
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  nestedAgentRunId?: string | null;
  timing?: SummaryTimingInput;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const question = parsed.question || parsed.positionals[0];
  if (!question) {
    throw new Error('A question is required.');
  }

  const inputText = readCliTextInput({
    text: parsed.text,
    file: parsed.file,
    stdinText: options.stdinText,
  });
  const imagePaths = parsed.images ?? [];
  let images: string[] = [];
  if (imagePaths.length > 0) {
    const config = await loadConfig({ ensure: true });
    const preset = getActiveModelPreset(config);
    images = new ImageAttachmentReader(
      resolveImageTokenBudget(preset),
      preset.VisionMaxImagePixels,
    ).readAll(imagePaths);
  }
  if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim() && images.length === 0) {
    throw new Error('stdin, --text, --file or --image required');
  }

  if (options.nestedAgentRunId) {
    options.stdout.write(`[siftkit] nested in agent run ${options.nestedAgentRunId}: summarization skipped to avoid model-lock deadlock; raw output follows\n`);
    options.stdout.write(`${(inputText ?? '').trim()}\n`);
    return 0;
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
    repoRoot: process.cwd(),
    question,
    inputText: inputText ?? '',
    images,
    format: normalizeCliFormat(parsed.format),
    policyProfile: normalizeCliPolicyProfileOrDefault(parsed.profile),
    provider: parsed.provider,
    model: parsed.model,
    sourceKind,
    commandExitCode,
    timing: options.timing,
  };
  const result = await new StatusServerApiClient().requestSummary(
    request,
    CliProgressRenderer.forCli(options.stderr, 'summary', parsed.progress === true),
  );
  options.stdout.write(`${result.Summary}\n`);
  return 0;
}
