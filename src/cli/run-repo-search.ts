import { CliApprovalPrompter } from './approval-prompter.js';
import {
  parseArguments,
  REPO_AGENT_SYNOPSIS,
  REPO_SEARCH_SYNOPSIS,
  type ResolvedCliArgs,
} from './args.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { formatRepoTaskOutput } from './repo-task-output.js';
import { StatusServerApiClient } from './status-server-api-client.js';

/** A run that prompts for approval needs a real terminal to prompt on; refuse a non-TTY stdin. */
export function assertStdinIsTty(required: boolean, stdin: { isTTY?: boolean } | undefined, context: string): void {
  if (required && stdin?.isTTY !== true) {
    throw new Error(`${context} requires a TTY (stdin is not interactive).`);
  }
}

export type RepoTaskMode = 'search' | 'agent';

export async function runRepoTaskCli(options: ResolvedCliArgs & {
  mode: RepoTaskMode;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const tokens = options.args;
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      options.mode === 'agent'
        ? `Usage: ${REPO_AGENT_SYNOPSIS}\n`
          + 'Approval is auto by default: the model reviews each command and escalates unsure ones to you.\n'
          + '--approval interactive asks you about every write/edit/run; --approval off runs autonomously.\n'
          + '--progress streams per-turn telemetry to stderr.\n'
        : `Usage: ${REPO_SEARCH_SYNOPSIS}\n`
          + 'Shortcut: siftkit -prompt "find x y z in this repo"\n'
          + '--progress streams per-turn telemetry to stderr (off by default to keep captured output clean).\n',
    );
    return 0;
  }

  const parsed = parseArguments(tokens);
  const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error(`A --prompt is required for repo-${options.mode === 'agent' ? 'agent' : 'search'}.`);
  }

  const stdin = options.stdin;
  const opLabel = options.mode === 'agent' ? 'repo-agent' : 'repo-search';
  const approvalMode = parsed.approvalMode
    ?? (options.mode === 'agent' ? 'auto' : 'interactive');
  const approvalOn = options.mode === 'agent' ? approvalMode !== 'off' : parsed.interactive === true;
  assertStdinIsTty(approvalOn, stdin, options.mode === 'agent' ? 'repo-agent approval mode' : '--interactive');
  const approvalPrompter = approvalOn && stdin
    ? new CliApprovalPrompter({ input: stdin, output: options.stderr })
    : undefined;
  const renderer = CliProgressRenderer.forCli(options.stderr, opLabel, parsed.progress === true);
  const client = new StatusServerApiClient();

  const response = options.mode === 'agent'
    ? await client.requestRepoAgent({
        prompt,
        repoRoot: process.cwd(),
        model: parsed.model,
        logFile: parsed.logFile,
        approval: approvalMode,
      }, renderer, approvalPrompter)
    : await client.requestRepoSearch({
        prompt,
        repoRoot: process.cwd(),
        model: parsed.model,
        logFile: parsed.logFile,
        interactive: parsed.interactive === true,
      }, renderer, approvalPrompter);

  options.stdout.write(`${formatRepoTaskOutput(response)}\n`);
  return 0;
}

export async function runRepoSearchCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'search', ...options });
}
