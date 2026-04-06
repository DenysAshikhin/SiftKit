import { getStatusBackendUrl } from '../config/index.js';
import { requestJson } from '../lib/http.js';
import { getCommandArgs, parseArguments } from './args.js';

export function getRepoSearchServiceUrl(): string {
  const target = new URL(getStatusBackendUrl());
  target.pathname = '/repo-search';
  target.search = '';
  target.hash = '';
  return target.toString();
}

export async function runRepoSearchCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const tokens = getCommandArgs(options.argv);
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      'Usage: siftkit repo-search --prompt "find x y z in this repo" [--model <model>] [--max-turns <n>] [--log-file <path>]\n'
      + 'Shortcut: siftkit -prompt "find x y z in this repo"\n'
    );
    return 0;
  }

  const parsed = parseArguments(tokens);
  const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const response = await requestJson<{
    requestId: string;
    transcriptPath: string;
    artifactPath: string;
    scorecard: Record<string, unknown>;
  }>({
    url: getRepoSearchServiceUrl(),
    method: 'POST',
    timeoutMs: 10 * 60 * 1000,
    body: JSON.stringify({
      prompt,
      repoRoot: process.cwd(),
      model: parsed.model,
      maxTurns: parsed.maxTurns,
      logFile: parsed.logFile,
    }),
  });

  const scorecard = response.scorecard && typeof response.scorecard === 'object'
    ? response.scorecard as { tasks?: Array<{ finalOutput?: unknown }> }
    : null;
  const finalOutputs = Array.isArray(scorecard?.tasks)
    ? scorecard.tasks
      .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
      .filter((value) => value.length > 0)
    : [];
  if (finalOutputs.length > 0) {
    options.stdout.write(`${finalOutputs.join('\n\n')}\n`);
    return 0;
  }
  options.stdout.write(`${JSON.stringify(response.scorecard, null, 2)}\n`);
  return 0;
}
