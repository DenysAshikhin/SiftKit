import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { CliApprovalPrompter } from './approval-prompter.js';
import { getCommandArgs, parseArguments, REPO_SEARCH_SYNOPSIS, REPO_AGENT_SYNOPSIS } from './args.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

/** A run that prompts for approval needs a real terminal to prompt on; refuse a non-TTY stdin. */
export function assertStdinIsTty(required: boolean, stdin: { isTTY?: boolean } | undefined, context: string): void {
  if (required && stdin?.isTTY !== true) {
    throw new Error(`${context} requires a TTY (stdin is not interactive).`);
  }
}

export type RepoTaskMode = 'search' | 'agent';

export async function runRepoTaskCli(options: {
  mode: RepoTaskMode;
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const tokens = getCommandArgs(options.argv);
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      options.mode === 'agent'
        ? `Usage: ${REPO_AGENT_SYNOPSIS}\n`
          + 'Approval is on by default; every write/edit/run awaits your decision. --no-approval runs autonomously.\n'
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
  const approvalOn = options.mode === 'agent' ? parsed.noApproval !== true : parsed.interactive === true;
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
        approval: parsed.noApproval !== true,
      }, renderer, approvalPrompter)
    : await client.requestRepoSearch({
        prompt,
        repoRoot: process.cwd(),
        model: parsed.model,
        logFile: parsed.logFile,
        interactive: parsed.interactive === true,
      }, renderer, approvalPrompter);

  const finalOutputs = response.scorecard.tasks
    .map((task) => task.finalOutput.trim())
    .filter((value) => value.length > 0);
  const formattedOutput = RepoSearchOutputFormatter.formatFinalOutputs(finalOutputs);
  if (formattedOutput) {
    options.stdout.write(`${formattedOutput}\n`);
    return 0;
  }
  options.stdout.write(`${JSON.stringify(response.scorecard, null, 2)}\n`);
  return 0;
}

export async function runRepoSearchCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'search', ...options });
}
