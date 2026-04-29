import { getStatusBackendUrl, getStatusServerUnavailableMessage } from '../config/index.js';
import { requestJson } from '../lib/http.js';
import { readSummaryInput, summarizeRequest } from '../summary/core.js';
import { isPassFailQuestion } from '../summary/measure.js';
import { parseDeterministicTestOutput } from '../summary/test-output.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';
import { getCommandArgs, parseArguments } from './args.js';

export function getSummaryServiceUrl(): string {
  const target = new URL(getStatusBackendUrl());
  target.pathname = '/summary';
  target.search = '';
  target.hash = '';
  return target.toString();
}

export async function runSummary(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
  timing?: Parameters<typeof summarizeRequest>[0]['timing'];
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
  const sourceKind = process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || hasStdinInput
    ? 'command-output'
    : 'standalone';
  const commandExitCode = process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
    ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
    : undefined;
  const request: SummaryRequest = {
    question,
    inputText: inputText ?? '',
    format: parsed.format === 'json' ? 'json' : 'text',
    policyProfile: (parsed.profile as SummaryRequest['policyProfile']) || 'general',
    backend: parsed.backend,
    model: parsed.model,
    sourceKind,
    commandExitCode,
    timing: options.timing,
  };
  const deterministicTestSummary = sourceKind === 'command-output' && isPassFailQuestion(question)
    ? parseDeterministicTestOutput({ inputText: request.inputText, commandExitCode })
    : null;
  const result = deterministicTestSummary
    ? await summarizeRequest(request)
    : await requestSummaryThroughStatusServer(request);
  options.stdout.write(`${result.Summary}\n`);
  return 0;
}

async function requestSummaryThroughStatusServer(request: SummaryRequest): Promise<SummaryResult> {
  try {
    return await requestJson<SummaryResult>({
      url: getSummaryServiceUrl(),
      method: 'POST',
      timeoutMs: 10 * 60 * 1000,
      body: JSON.stringify(request),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^HTTP \d+:/u.test(message)) {
      throw error;
    }
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|timed out|socket hang up/iu.test(message)) {
      throw new Error(getStatusServerUnavailableMessage());
    }
    throw error;
  }
}
