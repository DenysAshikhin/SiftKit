import {
  getStatusBackendUrl,
  getStatusServerUnavailableMessage,
} from '../config/index.js';
import {
  httpClient,
  logHttpClientBoundary,
  type HttpClient,
} from '../lib/http-client.js';
import type { SiftConfig } from '../config/index.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
  PresetListResult,
  PresetRunRequest,
  PresetRunResult,
} from '../command-output/types.js';
import type { EvalRequest, EvaluationResult } from '../eval-types.js';

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class StatusServerApiClient {
  private readonly client: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.client = client;
  }

  getConfig(): Promise<SiftConfig> {
    return this.requestConfig();
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

  async requestRepoSearch(request: Record<string, unknown>): Promise<RepoSearchExecutionResult> {
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
      return await this.client.requestJson<SiftConfig>({
        url: this.getServiceUrl('/config'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postSummary(request: SummaryRequest): Promise<SummaryResult> {
    try {
      return await this.client.requestJson<SummaryResult>({
        url: this.getServiceUrl('/summary'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postRepoSearch(request: Record<string, unknown>): Promise<RepoSearchExecutionResult> {
    try {
      return await this.client.requestJson<RepoSearchExecutionResult>({
        url: this.getServiceUrl('/repo-search'),
        method: 'POST',
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    try {
      return await this.client.requestJson<CommandOutputAnalyzeResult>({
        url: this.getServiceUrl('/command-output/analyze'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postPresetRun(request: PresetRunRequest): Promise<PresetRunResult> {
    try {
      return await this.client.requestJson<PresetRunResult>({
        url: this.getServiceUrl('/preset/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async requestPresetList(): Promise<PresetListResult> {
    try {
      return await this.client.requestJson<PresetListResult>({
        url: this.getServiceUrl('/preset/list'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postEvalRun(request: EvalRequest): Promise<EvaluationResult> {
    try {
      return await this.client.requestJson<EvaluationResult>({
        url: this.getServiceUrl('/eval/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/^HTTP \d+:/u.test(message)) {
      return error instanceof Error ? error : new Error(message);
    }
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|timed out|socket hang up/iu.test(message)) {
      return new Error(getStatusServerUnavailableMessage());
    }
    return error instanceof Error ? error : new Error(message);
  }
}
