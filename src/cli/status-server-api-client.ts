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
import { parseJsonObjectText, parseJsonText } from '../lib/json.js';
import { OPERATION_STREAM_EVENTS, OperationStreamErrorSchema } from '../lib/operation-stream.js';
import { SseClient } from '../lib/sse-client.js';
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
import { z } from '../lib/zod.js';
import type { CliProgressRenderer } from './progress-renderer.js';

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class StatusServerApiClient {
  private readonly client: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.client = client;
  }

  getConfig(): Promise<SiftConfig> {
    return this.requestConfig();
  }

  requestSummary(request: SummaryRequest, renderer: CliProgressRenderer): Promise<SummaryResult> {
    return this.requestStreamedOperation('/summary', JSON.stringify(request), SummaryResultSchema, renderer, 'summary');
  }

  requestRepoSearch(
    request: Record<string, JsonSerializable>,
    renderer: CliProgressRenderer,
  ): Promise<RepoSearchExecutionResult> {
    return this.requestStreamedOperation(
      '/repo-search',
      JSON.stringify(request),
      RepoSearchExecutionResultSchema,
      renderer,
      'repo-search',
    );
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

  private async requestStreamedOperation<T>(
    pathname: string,
    body: string,
    schema: z.ZodType<T>,
    renderer: CliProgressRenderer,
    task: LoggedHttpClientTask,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      for await (const frame of new SseClient().stream({
        url: this.getServiceUrl(pathname),
        body,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      })) {
        if (frame.event === OPERATION_STREAM_EVENTS.progress) {
          renderer.render(parseJsonObjectText(frame.data));
          continue;
        }
        if (frame.event === OPERATION_STREAM_EVENTS.error) {
          const payload = OperationStreamErrorSchema.parse(parseJsonObjectText(frame.data));
          throw new Error(payload.message);
        }
        if (frame.event === OPERATION_STREAM_EVENTS.result) {
          logHttpClientBoundary(
            task,
            'caller_response_received',
            `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
          );
          return parseJsonText(frame.data, schema);
        }
      }
      throw new Error('Operation stream ended before a result frame.');
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
