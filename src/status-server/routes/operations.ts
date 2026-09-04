import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject, JsonSerializable, OptionalJsonValue } from '../../lib/json-types.js';
import type { ServerContext } from '../server-types.js';
import {
  parseOptionalSummaryProvider,
  type SummaryPolicyProfile,
  type SummarySourceKind,
} from '../../summary/types.js';
import { readConfig } from '../config-store.js';
import { sendJson } from '../http-utils.js';
import { sendServerErrorJson } from '../error-response.js';
import { StatusPresetRunner } from '../preset-runner.js';
import {
  RepoSearchSseProgressWriter,
  SummarySseProgressWriter,
} from '../operation-progress-writers.js';
import { parseSummaryRequest } from '../route-request-normalizers.js';
import {
  StreamedOperationEndpoint,
  type ParsedStreamedRequest,
  type StreamedOperationContext,
} from './streamed-operation-endpoint.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';

function normalizeSummaryPolicyProfile(value: OptionalJsonValue): SummaryPolicyProfile {
  return (
    value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : 'general';
}

function normalizeSummarySourceKind(value: OptionalJsonValue): SummarySourceKind {
  return value === 'command-output' ? 'command-output' : 'standalone';
}

function normalizeCommandOutputKind(value: OptionalJsonValue): 'command' | 'interactive' {
  return value === 'interactive' ? 'interactive' : 'command';
}

function normalizeCommandOutputRiskLevel(value: OptionalJsonValue): 'informational' | 'debug' | 'risky' | undefined {
  return value === 'informational' || value === 'debug' || value === 'risky' ? value : undefined;
}

function normalizeCommandOutputReducerProfile(value: OptionalJsonValue): 'smart' | 'errors' | 'tail' | 'diff' | 'none' | undefined {
  return value === 'smart' || value === 'errors' || value === 'tail' || value === 'diff' || value === 'none' ? value : undefined;
}

type ParsedCommandOutputRoute = { parsedBody: JsonObject };

export class CommandOutputAnalyzeEndpoint extends StreamedOperationEndpoint<ParsedCommandOutputRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedCommandOutputRoute> {
    if (!new JsonRecordReader(parsedBody).optionalString('repoRoot')) {
      return { ok: false, error: 'Expected repoRoot.' };
    }
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedCommandOutputRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return ctx.engineService.analyzeCommandOutput({
      repoRoot: reader.string('repoRoot'),
      outputKind: normalizeCommandOutputKind(parsedBody.outputKind),
      exitCode: reader.number('exitCode') ?? 1,
      combinedText: typeof parsedBody.combinedText === 'string' ? parsedBody.combinedText : '',
      commandText: reader.optionalString('commandText'),
      question: reader.optionalString('question'),
      riskLevel: normalizeCommandOutputRiskLevel(parsedBody.riskLevel),
      reducerProfile: normalizeCommandOutputReducerProfile(parsedBody.reducerProfile),
      format: parsedBody.format === 'json' ? 'json' : 'text',
      policyProfile: normalizeSummaryPolicyProfile(parsedBody.policyProfile),
      provider: parseOptionalSummaryProvider(reader.optionalString('provider')),
      model: reader.optionalString('model'),
      noSummarize: parsedBody.noSummarize === true,
      config: readConfig(ctx.configPath),
      abortSignal: stream.abortSignal,
      progressWriter: new SummarySseProgressWriter(stream),
    });
  }
}

export class PresetListEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    try {
      const result = new StatusPresetRunner(ctx.engineService).listPresets();
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    }
    return;
  }
}

type ParsedPresetRunRoute = { parsedBody: JsonObject };

export class PresetRunEndpoint extends StreamedOperationEndpoint<ParsedPresetRunRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedPresetRunRoute> {
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedPresetRunRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return new StatusPresetRunner(ctx.engineService).run({
      presetId: String(parsedBody.presetId || ''),
      prompt: reader.optionalString('prompt'),
      question: reader.optionalString('question'),
      inputText: typeof parsedBody.inputText === 'string' ? parsedBody.inputText : undefined,
      format: parsedBody.format === 'json' ? 'json' : 'text',
      provider: parseOptionalSummaryProvider(reader.optionalString('provider')),
      model: reader.optionalString('model'),
      profile: reader.optionalString('profile'),
      sourceKind: normalizeSummarySourceKind(parsedBody.sourceKind),
      commandExitCode: reader.number('commandExitCode') ?? undefined,
      repoRoot: reader.optionalString('repoRoot'),
      maxTurns: reader.number('maxTurns') ?? undefined,
      logFile: reader.optionalString('logFile'),
    }, {
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      abortSignal: stream.abortSignal,
      summaryProgressWriter: new SummarySseProgressWriter(stream),
      repoSearchProgressWriter: new RepoSearchSseProgressWriter(stream),
    });
  }
}

type ParsedEvalRoute = { parsedBody: JsonObject };

export class EvalRunEndpoint extends StreamedOperationEndpoint<ParsedEvalRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedEvalRoute> {
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedEvalRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return ctx.engineService.runEvaluation({
      FixtureRoot: reader.optionalString('FixtureRoot'),
      RealLogPath: Array.isArray(parsedBody.RealLogPath) ? parsedBody.RealLogPath.map((value) => String(value)) : [],
      Provider: parseOptionalSummaryProvider(reader.optionalString('Provider')),
      Model: reader.optionalString('Model'),
    }, {
      progressWriter: new SummarySseProgressWriter(stream),
      abortSignal: stream.abortSignal,
    });
  }
}

type ParsedSummaryRoute = NonNullable<ReturnType<typeof parseSummaryRequest>>;

export class SummaryEndpoint extends StreamedOperationEndpoint<ParsedSummaryRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedSummaryRoute> {
    const summaryRequest = parseSummaryRequest(parsedBody);
    if (!summaryRequest) {
      return { ok: false, error: 'Expected question and inputText.' };
    }
    return { ok: true, value: summaryRequest };
  }

  protected async execute(
    ctx: ServerContext,
    summaryRequest: ParsedSummaryRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    return ctx.engineService.summarize({
      repoRoot: summaryRequest.repoRoot,
      presetId: summaryRequest.presetId,
      question: summaryRequest.question,
      inputText: summaryRequest.inputText,
      images: summaryRequest.images,
      format: summaryRequest.format,
      policyProfile: summaryRequest.policyProfile,
      provider: summaryRequest.provider,
      model: summaryRequest.model,
      sourceKind: summaryRequest.sourceKind,
      commandExitCode: summaryRequest.commandExitCode,
      requestTimeoutSeconds: summaryRequest.requestTimeoutSeconds,
      timing: summaryRequest.timing,
      promptPrefix: summaryRequest.promptPrefix,
      inferenceMaxTokens: summaryRequest.inferenceMaxTokens,
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      config: readConfig(ctx.configPath),
      abortSignal: stream.abortSignal,
      progressWriter: new SummarySseProgressWriter(stream),
    });
  }
}
