import {
  getStatusBackendUrl,
  getStatusServerUnavailableMessage,
} from '../config/index.js';
import { normalizeConfigObject } from '../config/normalization.js';
import {
  httpClient,
  logHttpClientBoundary,
  type HttpClient,
  type LoggedHttpClientTask,
} from '../lib/http-client.js';
import { JsonObjectSchema, type JsonSerializable } from '../lib/json-types.js';
import { AGENT_RUN_ID_HEADER, readNestedAgentRunId } from '../lib/agent-run-marker.js';
import { parseJsonText } from '../lib/json.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPERATION_STREAM_NO_RESULT_ERROR,
  StatusServerOperationError,
  classifyOperationStreamFrame,
} from '../lib/operation-stream.js';
import { toError } from '../lib/errors.js';
import type { SiftConfig } from '../config/index.js';
import {
  ApprovalRequestProgressEventSchema,
  RepoSearchExecutionResultSchema,
  type ApprovalRequestProgressEvent,
  type RepoSearchExecutionResult,
} from '../repo-search/types.js';
import {
  SummaryResultSchema,
  type SummaryRequest,
  type SummaryResult,
} from '../summary/types.js';
import {
  CommandOutputAnalyzeResultSchema,
  PresetListResultSchema,
  PresetRunResultSchema,
  type CommandOutputAnalyzeRequest,
  type CommandOutputAnalyzeResult,
  type PresetListResult,
  type PresetRunRequest,
  type PresetRunResult,
} from '../command-output/types.js';
import { EvaluationResultSchema, type EvalRequest, type EvaluationResult } from '../eval-types.js';
import { z } from '../lib/zod.js';
import type { JsonObject } from '../lib/json-types.js';
import {
  RepoSearchApprovalResultSchema,
  type ApprovalDecision,
  type RepoSearchApprovalRequest,
} from '../repo-search/engine/approval-gate.js';
import type { CliProgressRenderer } from './progress-renderer.js';
import type { ApprovalPrompter } from './approval-prompter.js';
import {
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  RepoAgentRunIdSchema,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../repo-agent/run-schemas.js';
import type {
  RepoAgentDecideRequest,
  RepoAgentStartRequest,
} from '../repo-agent/api-schemas.js';
import {
  AssistantAssertionExplanationSchema,
  AssistantConfigPatchRequestSchema,
  AssistantDeletionPreviewSchema,
  AssistantEvidenceDeletionPreviewSchema,
  AssistantFactoryResetPreviewSchema,
  AssistantMutationResponseSchema,
  AssistantNodeSummarySchema,
  AssistantAssertionDtoSchema,
  AssistantProjectionDtoSchema,
  AssistantPolicyDtoSchema,
  AssistantRestorePreviewResponseSchema,
  AssistantRestoreResultSchema,
  AssistantStatusResponseSchema,
  AssistantTopicForgetPreviewSchema,
  type AssistantConfig,
  type AssistantTopicForgetRequest,
} from '@siftkit/contracts';

const AssistantBootstrapSchema = z.object({ token: z.string().min(1) }).strict();
const AssistantSearchSchema = z.object({
  nodes: z.array(AssistantNodeSummarySchema),
  assertions: z.array(AssistantAssertionDtoSchema),
  projections: z.array(AssistantProjectionDtoSchema),
}).strict();
const AssistantPolicyListSchema = z.object({ items: z.array(AssistantPolicyDtoSchema) }).strict();
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

  searchAssistantMemory(token: string, query: string, modelIntent: boolean) {
    const target = new URL(this.getServiceUrl('/assistant/search'));
    target.searchParams.set('q', query);
    if (modelIntent) target.searchParams.set('modelIntent', 'true');
    return this.requestAssistant(target.toString(), 'GET', token, undefined, AssistantSearchSchema);
  }

  explainAssistantAssertion(token: string, assertionId: string) {
    return this.requestAssistant(
      `/assistant/graph/assertions/${encodeURIComponent(assertionId)}/explanation`,
      'GET', token, undefined, AssistantAssertionExplanationSchema,
    );
  }

  mutateAssistantAssertion(token: string, assertionId: string, action: string, payload: JsonObject) {
    return this.requestAssistant(
      `/assistant/graph/assertions/${encodeURIComponent(assertionId)}/${action}`,
      'POST', token, payload, AssistantMutationResponseSchema,
    );
  }

  previewAssistantForget(token: string, assertionId: string) {
    return this.requestAssistant(
      `/assistant/graph/assertions/${encodeURIComponent(assertionId)}`,
      'DELETE', token, { mode: 'preview' }, AssistantDeletionPreviewSchema,
    );
  }

  confirmAssistantForget(token: string, assertionId: string, previewToken: string) {
    return this.requestAssistant(
      `/assistant/graph/assertions/${encodeURIComponent(assertionId)}`,
      'DELETE', token, { mode: 'confirm', previewToken }, AssistantMutationResponseSchema,
    );
  }

  previewAssistantEvidenceDeletion(token: string, evidenceId: string) {
    return this.requestAssistant(
      `/assistant/evidence/${encodeURIComponent(evidenceId)}/deletion-preview`,
      'GET', token, undefined, AssistantEvidenceDeletionPreviewSchema,
    );
  }

  confirmAssistantEvidenceDeletion(token: string, evidenceId: string, previewToken: string) {
    return this.requestAssistant(
      `/assistant/evidence/${encodeURIComponent(evidenceId)}`,
      'DELETE', token, { previewToken }, AssistantMutationResponseSchema,
    );
  }

  previewAssistantTopicForget(token: string, topicKey: string) {
    return this.requestAssistant(
      '/assistant/topics/forget-preview', 'POST', token, { topicKey },
      AssistantTopicForgetPreviewSchema,
    );
  }

  confirmAssistantTopicForget(token: string, request: AssistantTopicForgetRequest) {
    return this.requestAssistant(
      '/assistant/topics/forget', 'POST', token, request, AssistantMutationResponseSchema,
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

  listAssistantPolicies(token: string) {
    return this.requestAssistant(
      '/assistant/policies', 'GET', token, undefined, AssistantPolicyListSchema,
    );
  }

  blockAssistantPolicyTopic(token: string, topic: string) {
    return this.requestAssistant(
      '/assistant/policies/block-topic', 'POST', token, { topic }, AssistantMutationResponseSchema,
    );
  }

  rebuildAssistantProjections(token: string) {
    return this.requestAssistant(
      '/assistant/projections/rebuild', 'POST', token, {}, AssistantMutationResponseSchema,
    );
  }

  requestSummary(request: SummaryRequest, renderer: CliProgressRenderer): Promise<SummaryResult> {
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

  analyzeCommandOutput(
    request: CommandOutputAnalyzeRequest,
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

  runEvaluation(request: EvalRequest, renderer: CliProgressRenderer): Promise<EvaluationResult> {
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
      const nestedAgentRunId = readNestedAgentRunId();
      for await (const frame of this.client.streamSse({
        ...(nestedAgentRunId ? { headers: { [AGENT_RUN_ID_HEADER]: nestedAgentRunId } } : {}),
        url: this.getServiceUrl(pathname),
        body,
        idleTimeoutMs,
      })) {
        const classified = classifyOperationStreamFrame(frame, schema);
        if (classified.kind === 'progress') {
          const progressEvent = classified.event;
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
          continue;
        }
        if (classified.kind === 'result') {
          logHttpClientBoundary(
            task,
            'caller_response_received',
            `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
          );
          return classified.result;
        }
      }
      throw new Error(OPERATION_STREAM_NO_RESULT_ERROR);
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
