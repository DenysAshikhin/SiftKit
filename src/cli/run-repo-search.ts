import { CliApprovalPrompter } from './approval-prompter.js';
import {
  parseArguments,
  REPO_SEARCH_SYNOPSIS,
  type ResolvedCliArgs,
} from './args.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { formatRepoTaskOutput } from '../repo-agent/run-output.js';
import { StatusServerApiClient } from './status-server-api-client.js';
import { assertStdinIsTty } from './tty.js';
import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';

export async function runRepoSearchCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const tokens = options.args;
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      `Usage: ${REPO_SEARCH_SYNOPSIS}\n`
        + 'Shortcut: siftkit -prompt "find x y z in this repo"\n'
        + '--progress streams per-turn telemetry to stderr (off by default to keep captured output clean).\n',
    );
    return 0;
  }

  const parsed = parseArguments(tokens);
  const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const images = new ImageAttachmentReader().readAll(parsed.images ?? []);
  const stdin = options.stdin;
  const interactive = parsed.interactive === true;
  assertStdinIsTty(interactive, stdin, '--interactive');
  const approvalPrompter = interactive && stdin
    ? new CliApprovalPrompter({ input: stdin, output: options.stderr })
    : undefined;
  const renderer = CliProgressRenderer.forCli(
    options.stderr,
    'repo-search',
    parsed.progress === true,
  );
  const client = new StatusServerApiClient();

  const response = await client.requestRepoSearch({
    presetId: 'repo-search',
    prompt,
    repoRoot: process.cwd(),
    model: parsed.model,
    logFile: parsed.logFile,
    interactive,
    images,
  }, renderer, approvalPrompter);

  options.stdout.write(`${formatRepoTaskOutput(response)}\n`);
  return 0;
}
