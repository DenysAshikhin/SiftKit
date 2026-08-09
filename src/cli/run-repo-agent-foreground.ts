import { CliApprovalPrompter } from './approval-prompter.js';
import { CliProgressRenderer } from './progress-renderer.js';
import type { RepoAgentStartInvocation } from './repo-agent-args.js';
import { buildRepoAgentServerRequest } from './repo-agent-request.js';
import { formatRepoTaskOutput } from '../repo-agent/run-output.js';
import { StatusServerApiClient } from './status-server-api-client.js';
import { assertStdinIsTty } from './tty.js';
import { getActiveModelPreset, loadConfig } from '../config/index.js';

export async function runRepoAgentForegroundCli(options: {
  invocation: RepoAgentStartInvocation;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const approvalOn = options.invocation.approval !== 'off';
  assertStdinIsTty(
    approvalOn,
    options.stdin,
    'repo-agent approval mode',
  );
  const approvalPrompter = approvalOn && options.stdin
    ? new CliApprovalPrompter({
        input: options.stdin,
        output: options.stderr,
      })
    : undefined;
  const renderer = CliProgressRenderer.forCli(
    options.stderr,
    'repo-agent',
    options.invocation.progress,
  );
  const config = await loadConfig({ ensure: true });
  const preset = getActiveModelPreset(config);
  const request = buildRepoAgentServerRequest({
    task: options.invocation.task,
    repoRoot: process.cwd(),
    approval: options.invocation.approval,
    images: options.invocation.images,
    model: options.invocation.model,
    logFile: options.invocation.logFile,
    preset,
  });
  const response = await new StatusServerApiClient().requestRepoAgent(
    request,
    renderer,
    approvalPrompter,
  );
  options.stdout.write(`${formatRepoTaskOutput(response)}\n`);
  return 0;
}
