import { ensureStatusServerReachable } from '../config/index.js';
import {
  RepoAgentRunResultSchema,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../repo-agent/run-schemas.js';
import type { RepoAgentDecideRequest } from '../repo-agent/api-schemas.js';
import { CliApprovalPrompter, type ApprovalPrompter } from './approval-prompter.js';
import { CliProgressRenderer } from './progress-renderer.js';
import type { RepoAgentInvocation } from './repo-agent-args.js';
import { REPO_AGENT_EXIT_CODES } from './repo-agent-help.js';
import { buildRepoAgentServerRequest } from './repo-agent-request.js';
import type { StatusServerApiClient } from './status-server-api-client.js';
import { assertStdinIsTty } from './tty.js';
import { RepoAgentDecideRequestSchema } from '../repo-agent/api-schemas.js';

export type RepoAgentApi = Pick<StatusServerApiClient, 'requestRepoAgent' | 'requestRepoAgentDecide' | 'requestRepoAgentStatus'>;

export type RepoAgentCommandStreams = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

function buildApprovalRequiredNotice(
  result: Extract<RepoAgentRunResult, { status: 'approval_required' }>,
): string {
  const lines = [
    'Exiting: approval required before the agent may continue.',
    `Run: ${result.runId}`,
    `Tool: ${result.approval.toolName}`,
    `Command: ${result.approval.command}`,
  ];
  if (result.approval.reviewPayload !== null) {
    lines.push('Review payload:', result.approval.reviewPayload);
  }
  lines.push(
    'Respond with one of:',
    `  ${result.decide.approve}`,
    `  ${result.decide.deny}`,
    `  ${result.decide.abort}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Write and wait for the chunk to reach the OS pipe before returning an exit code. */
function writeFlushed(stream: NodeJS.WritableStream, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

export class RepoAgentCommand {
  private readonly api: RepoAgentApi;

  constructor(options: { api: RepoAgentApi }) {
    this.api = options.api;
  }

  async run(invocation: RepoAgentInvocation, streams: RepoAgentCommandStreams): Promise<number> {
    switch (invocation.kind) {
      case 'start':
        return this.runStart(invocation, streams);
      case 'decide':
        return this.runDecide(invocation, streams);
      case 'status':
        return this.runStatus(invocation, streams);
    }
  }

  private async runStart(
    invocation: Extract<RepoAgentInvocation, { kind: 'start' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    await ensureStatusServerReachable();
    const interactive = invocation.approval === 'interactive';
    assertStdinIsTty(interactive, streams.stdin, 'repo-agent interactive approval');
    const prompter: ApprovalPrompter | undefined = interactive && streams.stdin
      ? new CliApprovalPrompter({ input: streams.stdin, output: streams.stderr })
      : undefined;
    const renderer = CliProgressRenderer.forCli(streams.stderr, 'repo-agent', invocation.progress);
    const request = buildRepoAgentServerRequest({
      task: invocation.task,
      repoRoot: process.cwd(),
      approval: invocation.approval,
      images: invocation.images,
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(invocation.logFile === undefined ? {} : { logFile: invocation.logFile }),
    });
    const result = await this.api.requestRepoAgent(request, renderer, prompter);
    return this.writeResult(result, streams);
  }

  private async runDecide(
    invocation: Extract<RepoAgentInvocation, { kind: 'decide' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    await ensureStatusServerReachable();
    const renderer = CliProgressRenderer.forCli(streams.stderr, 'repo-agent', invocation.progress);
    const request: RepoAgentDecideRequest = RepoAgentDecideRequestSchema.parse({
      runId: invocation.runId,
      decision: invocation.decision,
      ...(invocation.reason === undefined ? {} : { reason: invocation.reason }),
    });
    const result = await this.api.requestRepoAgentDecide(request, renderer);
    return this.writeResult(result, streams);
  }

  private async runStatus(
    invocation: Extract<RepoAgentInvocation, { kind: 'status' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    await ensureStatusServerReachable();
    const state: RepoAgentRunState = await this.api.requestRepoAgentStatus(invocation.runId);
    await writeFlushed(streams.stdout, `${JSON.stringify(state)}\n`);
    return 0;
  }

  private async writeResult(
    input: RepoAgentRunResult,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    const result = RepoAgentRunResultSchema.parse(input);
    if (result.status === 'approval_required') {
      await writeFlushed(streams.stderr, buildApprovalRequiredNotice(result));
    }
    await writeFlushed(streams.stdout, `${JSON.stringify(result)}\n`);
    return REPO_AGENT_EXIT_CODES[result.status];
  }
}
