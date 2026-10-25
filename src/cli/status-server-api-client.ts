import {
  getStatusBackendUrl,
  getStatusServerUnavailableMessage,
} from '../config/index.ts';
import { normalizeConfigObject } from '../config/normalization.ts';
import {
  OrchestratorProgressSchema,
  OrchestratorRunStateSchema,
  type OrchestratorDecideRequest,
  type OrchestratorProgress,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
} from '@siftkit/contracts';
import {
  httpClient,
  logHttpClientBoundary,
  type HttpClient,
  type LoggedHttpClientTask,
} from '../lib/http-client.ts';
import { JsonObjectSchema, type JsonSerializable } from '../lib/json-types.ts';
import { AGENT_RUN_ID_HEADER, readNestedAgentRunId } from '../lib/agent-run-marker.ts';
import { parseJsonText } from '../lib/json.ts';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StatusServerOperationError,
  streamOperationResult,
} from '../lib/operation-stream.ts';
import { toError } from '../lib/errors.ts';
import type { SiftConfig } from '../config/index.ts';
import {
  ApprovalRequestProgressEventSchema,
  RepoSearchExecutionResultSchema,
  type ApprovalRequestProgressEvent,
  type RepoSearchExecutionResult,
} from '../repo-search/types.ts';
import {
  SummaryResultSchema,
  type SummaryApiRequest,
  type SummaryResult,
} from '../summary/types.ts';
import {
  CommandOutputAnalyzeResultSchema,
  PresetListResultSchema,
  PresetRunResultSchema,
  type CommandOutputAnalyzeApiRequest,
  type CommandOutputAnalyzeResult,
  type PresetListResult,
  type PresetRunRequest,
  type PresetRunResult,
} from '../command-output/types.ts';
import { EvaluationResultSchema, type EvalApiRequest, type EvaluationResult } from '../eval-types.ts';
import { z } from '../lib/zod.ts';
import type { JsonObject } from '../lib/json-types.ts';
import {
  RepoSearchApprovalResultSchema,
  type ApprovalDecision,
  type RepoSearchApprovalRequest,
} from '../repo-search/engine/approval-gate.ts';
import type { CliProgressRenderer } from './progress-renderer.ts';
import type { ApprovalPrompter } from './approval-prompter.ts';
import {
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  RepoAgentRunIdSchema,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../repo-agent/run-schemas.ts';
import type {
  RepoAgentDecideRequest,
  RepoAgentStartRequest,
} from '../repo-agent/api-schemas.ts';
import {
  AssistantConfigPatchRequestSchema,
  AssistantFactoryResetPreviewSchema,
  AssistantRestorePreviewResponseSchema,
  AssistantRestoreResultSchema,
  AssistantStatusResponseSchema,
  type AssistantConfig,
} from '@siftkit/contracts';

const AssistantBootstrapSchema = z.object({ token: z.string().min(1) }).strict();
const AssistantOkSchema = z.object({ ok: z.literal(true) }).strict();
const ZIP_CONTENT_TYPE = 'application/zip';

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REPO_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const StatusServerApiClientOptionsSchema = z.strictObject({
  repoAgentIdleTimeoutMs: z.number().int().positive().finite().optional(),
});
export type StatusServerApiClientOptions = z.infer<
  typeof StatusServerApiClientOptionsSchema
>;

export class StatusServerApiClient {
  private readonly client: HttpClient;
  private readonly repoAgentIdleTimeoutMs: number;

  constructor(
    client: HttpClient = httpClient,
    options: StatusServerApiClientOptions = {},
  ) {
    const parsedOptions = StatusServerApiClientOptionsSchema.parse(options);
    this.client = client;
    this.repoAgentIdleTimeoutMs = parsedOptions.repoAgentIdleTimeoutMs
      ?? DEFAULT_REPO_AGENT_IDLE_TIMEOUT_MS;
  }

  getConfig(): Promise<SiftConfig> {
    return this.requestConfig();
  }

  async bootstrapAssistantToken(): Promise<string> {
    const response = await this.client.requestJson({
      url: this.getServiceUrl('/assistant/auth/bootstrap'), method: 'GET',
      timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    }, AssistantBootstrapSchema);
    return response.token;
  }

  requestAssistantStatus(token: string) {
    return this.requestAssistant('/assistant/status', 'GET', token, undefined, AssistantStatusResponseSchema);
  }

  requestAssistantConfig(token: string) {
    return this.requestAssistant(
      '/assistant/config', 'GET', token, undefined, AssistantConfigPatchRequestSchema,
    );
  }

  patchAssistantConfig(token: string, assistant: AssistantConfig) {
    return this.requestAssistant(
      '/assistant/config', 'PATCH', token, { assistant }, AssistantConfigPatchRequestSchema,
    );
  }

  previewAssistantFactoryReset(token: string) {
    return this.requestAssistant(
      '/assistant/factory-reset/preview', 'GET', token, undefined,
      AssistantFactoryResetPreviewSchema,
    );
  }

  confirmAssistantFactoryReset(token: string, previewToken: string) {
    return this.requestAssistant(
      '/assistant/factory-reset', 'POST', token, { previewToken }, AssistantOkSchema,
    );
  }

  /** The archive routes answer `application/zip`; a utf8 round trip would corrupt every one. */
  requestAssistantZip(pathname: string, token: string, payload?: JsonObject): Promise<Buffer> {
    return this.requestAssistantBytes(pathname, token, {
      ...(payload === undefined
        ? {}
        : { body: Buffer.from(JSON.stringify(payload), 'utf8'), contentType: 'application/json' }),
    });
  }

  async postAssistantRestorePreview(token: string, bytes: Buffer) {
    const response = await this.requestAssistantBytes('/assistant/restore-preview', token, {
      body: bytes, contentType: ZIP_CONTENT_TYPE,
    });
    return parseJsonText(response.toString('utf8'), AssistantRestorePreviewResponseSchema);
  }

  confirmAssistantRestore(token: string, uploadId: string, confirmToken: string) {
    return this.requestAssistant(
      '/assistant/restore', 'POST', token, { uploadId, confirmToken },
      AssistantRestoreResultSchema,
    );
  }

  requestSummary(request: SummaryApiRequest, renderer: CliProgressRenderer): Promise<SummaryResult> {
    return this.requestStreamedOperation('/summary', JSON.stringify(request), SummaryResultSchema, renderer, 'summary');
  }

  requestRepoSearch(
    request: Record<string, JsonSerializable>,
    renderer: CliProgressRenderer,
    approvalPrompter?: ApprovalPrompter,
  ): Promise<RepoSearchExecutionResult> {
    return this.requestStreamedOperation(
      '/repo-search',
      JSON.stringify(request),
      RepoSearchExecutionResultSchema,
      renderer,
      'repo-search',
      approvalPrompter,
    );
  }

  requestRepoAgent(
    request: RepoAgentStartRequest,
    renderer: CliProgressRenderer,
    approvalPrompter?: ApprovalPrompter,
  ): Promise<RepoAgentRunResult> {
    return this.requestStreamedOperation(
      '/repo-agent',
      JSON.stringify(request),
      RepoAgentRunResultSchema,
      renderer,
      'repo-agent',
      approvalPrompter,
      this.repoAgentIdleTimeoutMs,
    );
  }

  requestRepoAgentDecide(
    request: RepoAgentDecideRequest,
    renderer: CliProgressRenderer,
  ): Promise<RepoAgentRunResult> {
    return this.requestStreamedOperation(
      '/repo-agent/decide',
      JSON.stringify(request),
      RepoAgentRunResultSchema,
      renderer,
      'repo-agent',
      undefined,
      this.repoAgentIdleTimeoutMs,
    );
  }

  requestRepoAgentStatus(runId: string): Promise<RepoAgentRunState> {
    const validatedRunId = RepoAgentRunIdSchema.parse(runId);
    const target = new URL(this.getServiceUrl('/repo-agent/status'));
    target.searchParams.set('runId', validatedRunId);
    return this.requestJsonState(target.toString());
  }

  startOrchestrator(request: OrchestratorStartRequest): Promise<OrchestratorRunState> {
    return this.postOrchestrator('/orchestrator', request);
  }

  decideOrchestrator(request: OrchestratorDecideRequest): Promise<OrchestratorRunState> {
    return this.postOrchestrator('/orchestrator/decide', request);
  }

  abortOrchestrator(runId: string): Promise<OrchestratorRunState> {
    return this.postOrchestrator('/orchestrator/abort', { runId });
  }

  async readOrchestratorStatus(runId: string): Promise<OrchestratorRunState> {
    const target = new URL(this.getServiceUrl('/orchestrator/status'));
    target.searchParams.set('runId', runId);
    try {
      return await this.client.requestJson({ url: target.toString(), method: 'GET', timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS },
        OrchestratorRunStateSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  /** Committed progress after the cursor, then the terminal state; detaching never stops the run. */
  async *followOrchestrator(runId: string, afterSequence: number): AsyncGenerator<OrchestratorProgress, OrchestratorRunState> {
    try {
      const stream = streamOperationResult(this.client, {
        url: this.getServiceUrl('/orchestrator/events'),
        body: JSON.stringify({ runId, afterSequence }),
        idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }, OrchestratorRunStateSchema);
      for (;;) {
        const next = await stream.next();
        if (next.done) return next.value;
        yield OrchestratorProgressSchema.parse(next.value);
      }
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async postOrchestrator(pathname: string, body: JsonSerializable): Promise<OrchestratorRunState> {
    const nestedAgentRunId = readNestedAgentRunId(this.getServiceUrl(pathname));
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl(pathname), method: 'POST', body: JSON.stringify(body), timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        ...(nestedAgentRunId ? { headers: { [AGENT_RUN_ID_HEADER]: nestedAgentRunId } } : {}),
      }, OrchestratorRunStateSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  analyzeCommandOutput(
    request: CommandOutputAnalyzeApiRequest,
    renderer: CliProgressRenderer,
  ): Promise<CommandOutputAnalyzeResult> {
    return this.requestStreamedOperation(
      '/command-output/analyze',
      JSON.stringify(request),
      CommandOutputAnalyzeResultSchema,
      renderer,
      'command-output',
    );
  }

  runPreset(request: PresetRunRequest, renderer: CliProgressRenderer): Promise<PresetRunResult> {
    return this.requestStreamedOperation(
      '/preset/run',
      JSON.stringify(request),
      PresetRunResultSchema,
      renderer,
      'preset',
    );
  }

  listPresets(): Promise<PresetListResult> {
    return this.requestPresetList();
  }

  runEvaluation(request: EvalApiRequest, renderer: CliProgressRenderer): Promise<EvaluationResult> {
    return this.requestStreamedOperation(
      '/eval/run',
      JSON.stringify(request),
      EvaluationResultSchema,
      renderer,
      'eval',
    );
  }

  private getServiceUrl(pathname: string): string {
    if (/^https?:\/\//u.test(pathname)) return pathname;
    const target = new URL(getStatusBackendUrl());
    target.pathname = pathname;
    target.search = '';
    target.hash = '';
    return target.toString();
  }

  private async requestAssistant<T>(
    pathname: string,
    method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
    token: string,
    payload: JsonObject | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl(pathname),
        method,
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }, schema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async requestAssistantBytes(
    pathname: string,
    token: string,
    payload: { body?: Buffer; contentType?: string },
  ): Promise<Buffer> {
    try {
      return await this.client.requestBytes({
        url: this.getServiceUrl(pathname),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload.contentType === undefined
            ? {}
            : { 'Content-Type': payload.contentType }),
        },
        ...(payload.body === undefined ? {} : { body: payload.body }),
      });
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async requestConfig(): Promise<SiftConfig> {
    try {
      const config = await this.client.requestJson({
        url: this.getServiceUrl('/config'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      }, JsonObjectSchema);
      return normalizeConfigObject(config);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async requestPresetList(): Promise<PresetListResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/preset/list'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      }, PresetListResultSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async requestJsonState(url: string): Promise<RepoAgentRunState> {
    try {
      return await this.client.requestJson({
        url,
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      }, RepoAgentRunStateSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async requestStreamedOperation<T>(
    pathname: string,
    body: string,
    schema: z.ZodType<T>,
    renderer: CliProgressRenderer,
    task: LoggedHttpClientTask,
    approvalPrompter?: ApprovalPrompter,
    idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const nestedAgentRunId = readNestedAgentRunId(this.getServiceUrl(pathname));
      const stream = streamOperationResult(this.client, {
        ...(nestedAgentRunId ? { headers: { [AGENT_RUN_ID_HEADER]: nestedAgentRunId } } : {}),
        url: this.getServiceUrl(pathname),
        body,
        idleTimeoutMs,
      }, schema);
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          logHttpClientBoundary(
            task,
            'caller_response_received',
            `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
          );
          return next.value;
        }
        const progressEvent = next.value;
        if (progressEvent.kind === 'approval_request') {
          if (!approvalPrompter) {
            throw new Error('Received approval_request on a non-interactive run.');
          }
          // The frame crossed the wire, so it is parsed back into its declared shape here.
          const approval = ApprovalRequestProgressEventSchema.parse(progressEvent);
          const decision = await approvalPrompter.promptDecision(approval);
          await this.submitApproval(approval, decision);
          continue;
        }
        renderer.render(progressEvent);
      }
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async submitApproval(event: ApprovalRequestProgressEvent, decision: ApprovalDecision): Promise<void> {
    const body: RepoSearchApprovalRequest = {
      requestId: event.requestId,
      approvalId: event.approvalId,
      decision: decision.kind,
      ...(decision.kind === 'deny' && decision.reason ? { reason: decision.reason } : {}),
    };
    try {
      await this.client.requestJson({
        url: this.getServiceUrl('/repo-search/approval'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(body),
      }, RepoSearchApprovalResultSchema);
    } catch (error) {
      if (/^HTTP 409:/u.test(toError(error).message)) {
        return;
      }
      throw this.normalizeError(toError(error));
    }
  }

  private normalizeError(error: Error): Error {
    if (error instanceof StatusServerOperationError) {
      return error;
    }
    const message = error.message;
    if (/^HTTP \d+:/u.test(message)) {
      return error;
    }
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|timed out|socket hang up/iu.test(message)) {
      return new Error(getStatusServerUnavailableMessage());
    }
    return error;
  }
}
