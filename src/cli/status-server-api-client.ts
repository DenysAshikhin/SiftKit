import {
  getStatusBackendUrl,
  getStatusServerUnavailableMessage,
} from '../config/index.js';
import { normalizeConfigObject } from '../config/normalization.js';
import {
  httpClient,
  logHttpClientBoundary,
  type HttpClient,
} from '../lib/http-client.js';
import { JsonObjectSchema, type JsonSerializable } from '../lib/json-types.js';
import { toError } from '../lib/errors.js';
import type { SiftConfig } from '../config/index.js';
import {
  RepoSearchExecutionResultSchema,
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
import {
  type BackendRuntimeStatus,
  type BackendRuntimeUpdateRequest,
  type BackendRuntimeUpdateResponse,
} from '@siftkit/contracts';
import { z } from '../lib/zod.js';

const BackendRuntimeStatusWireSchema = z.object({
  active: z.enum(['llama', 'exl3']).nullable(),
  selected: z.enum(['llama', 'exl3']),
  pending: z.enum(['llama', 'exl3']).nullable(),
  state: z.enum(['stopped', 'starting', 'ready', 'draining', 'stopping', 'failed']),
  model: z.string().nullable(),
  error: z.string().nullable(),
  rollback: z.string().nullable(),
});
const BackendRuntimeUpdateResponseWireSchema = z.object({
  outcome: z.enum(['already_active', 'switched', 'queued', 'failed']),
  status: BackendRuntimeStatusWireSchema,
});

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class StatusServerApiClient {
  private readonly client: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.client = client;
  }

  getConfig(): Promise<SiftConfig> {
    return this.requestConfig();
  }

  async getBackendStatus(): Promise<BackendRuntimeStatus> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/runtime/backend'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      }, BackendRuntimeStatusWireSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  async selectBackend(request: BackendRuntimeUpdateRequest): Promise<BackendRuntimeUpdateResponse> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/runtime/backend'),
        method: 'PUT',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      }, BackendRuntimeUpdateResponseWireSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  async requestSummary(request: SummaryRequest): Promise<SummaryResult> {
    const startedAt = Date.now();
    const result = await this.postSummary(request);
    logHttpClientBoundary(
      'summary',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async requestRepoSearch(request: Record<string, JsonSerializable>): Promise<RepoSearchExecutionResult> {
    const startedAt = Date.now();
    const result = await this.postRepoSearch(request);
    logHttpClientBoundary(
      'repo-search',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async analyzeCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    const startedAt = Date.now();
    const result = await this.postCommandOutput(request);
    logHttpClientBoundary(
      'command-output',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async runPreset(request: PresetRunRequest): Promise<PresetRunResult> {
    const startedAt = Date.now();
    const result = await this.postPresetRun(request);
    logHttpClientBoundary(
      'preset',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  listPresets(): Promise<PresetListResult> {
    return this.requestPresetList();
  }

  async runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
    const startedAt = Date.now();
    const result = await this.postEvalRun(request);
    logHttpClientBoundary(
      'eval',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  private getServiceUrl(pathname: string): string {
    const target = new URL(getStatusBackendUrl());
    target.pathname = pathname;
    target.search = '';
    target.hash = '';
    return target.toString();
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

  private async postSummary(request: SummaryRequest): Promise<SummaryResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/summary'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      }, SummaryResultSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async postRepoSearch(request: Record<string, JsonSerializable>): Promise<RepoSearchExecutionResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/repo-search'),
        method: 'POST',
        body: JSON.stringify(request),
      }, RepoSearchExecutionResultSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async postCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/command-output/analyze'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      }, CommandOutputAnalyzeResultSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private async postPresetRun(request: PresetRunRequest): Promise<PresetRunResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/preset/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      }, PresetRunResultSchema);
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

  private async postEvalRun(request: EvalRequest): Promise<EvaluationResult> {
    try {
      return await this.client.requestJson({
        url: this.getServiceUrl('/eval/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      }, EvaluationResultSchema);
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }

  private normalizeError(error: Error): Error {
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
