import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { CliApprovalPrompter } from './approval-prompter.js';
import { getCommandArgs, parseArguments } from './args.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

/** --interactive needs a real terminal to prompt on; refuse a non-TTY stdin. */
export function assertInteractiveStdinIsTty(interactive: boolean, stdin?: { isTTY?: boolean }): void {
  if (interactive && stdin?.isTTY !== true) {
    throw new Error('--interactive requires a TTY (stdin is not interactive).');
  }
}

export async function runRepoSearchCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const tokens = getCommandArgs(options.argv);
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      'Usage: siftkit repo-search --prompt "find x y z in this repo" [--model <model>] [--log-file <path>] [--interactive]\n'
      + 'Shortcut: siftkit -prompt "find x y z in this repo"\n'
    );
    return 0;
  }

  const parsed = parseArguments(tokens);
  const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const stdin = options.stdin;
  assertInteractiveStdinIsTty(parsed.interactive === true, stdin);
  const approvalPrompter = parsed.interactive && stdin
    ? new CliApprovalPrompter({ input: stdin, output: options.stderr })
    : undefined;

  const response = await new StatusServerApiClient().requestRepoSearch({
    prompt,
    repoRoot: process.cwd(),
    model: parsed.model,
    logFile: parsed.logFile,
    interactive: parsed.interactive === true,
  }, new CliProgressRenderer(options.stderr, 'repo-search'), approvalPrompter);

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
