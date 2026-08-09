import type { CliProgressRenderer } from '../cli/progress-renderer.js';
import { formatRepoTaskOutput } from '../repo-agent/run-output.js';
import type { StatusServerApiClient } from '../cli/status-server-api-client.js';
import { buildRepoAgentServerRequest } from '../cli/repo-agent-request.js';
import { toError } from '../lib/errors.js';
import { RepoAgentBoundaryWaiter } from './boundary-waiter.js';
import { RepoAgentRunApprovalPrompter } from './run-approval-prompter.js';
import { isTerminalStatus } from './run-schemas.js';
import type { RepoAgentRunStore } from './run-store.js';
import { getActiveModelPreset, loadConfig } from '../config/index.js';

export class RepoAgentWorker {
  private readonly store: RepoAgentRunStore;
  private readonly apiClient: StatusServerApiClient;
  private readonly progressRenderer: CliProgressRenderer;
  private readonly boundaryWaiter: RepoAgentBoundaryWaiter;

  constructor(options: {
    store: RepoAgentRunStore;
    apiClient: StatusServerApiClient;
    progressRenderer: CliProgressRenderer;
    boundaryWaiter: RepoAgentBoundaryWaiter;
  }) {
    this.store = options.store;
    this.apiClient = options.apiClient;
    this.progressRenderer = options.progressRenderer;
    this.boundaryWaiter = options.boundaryWaiter;
  }

  async run(runId: string): Promise<void> {
    const request = this.store.readRequest(runId);
    const initial = this.store.readState(runId);
    if (isTerminalStatus(initial.status)) {
      return;
    }
    if (initial.status !== 'starting') {
      throw new Error(`Worker requires starting state, received ${initial.status}.`);
    }
    this.store.transition(runId, initial.revision, {
      runId,
      revision: initial.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'running',
      pid: process.pid,
    });
    const approvalPrompter = new RepoAgentRunApprovalPrompter({
      store: this.store,
      waiter: this.boundaryWaiter,
      runId,
    });

    try {
      const config = await loadConfig({ ensure: true });
      const preset = getActiveModelPreset(config);
      const result = await this.apiClient.requestRepoAgent(
        buildRepoAgentServerRequest({ ...request, preset }),
        this.progressRenderer,
        approvalPrompter,
      );
      const current = this.store.readState(runId);
      if (isTerminalStatus(current.status)) {
        return;
      }
      this.store.transition(runId, current.revision, {
        runId,
        revision: current.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'completed',
        pid: process.pid,
        output: formatRepoTaskOutput(result),
      });
    } catch (error) {
      const current = this.store.readState(runId);
      if (isTerminalStatus(current.status)) {
        return;
      }
      const failure = toError(error);
      this.store.transition(runId, current.revision, {
        runId,
        revision: current.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'failed',
        pid: process.pid,
        error: failure.message,
      });
      throw failure;
    }
  }

}
