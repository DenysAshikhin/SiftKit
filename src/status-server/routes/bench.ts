import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

import {
  BENCH_GENERATION_HEADER,
  BENCH_RESIDENCY_HEADER,
  BENCH_ROUTE_PREFIX,
  BenchIdentityRequestSchema,
  BenchIdentityResponseSchema,
  type BenchResidentCard,
} from '@siftkit/contracts';
import type { ModelRuntimePreset } from '../../config/types.ts';
import { Exl3PresetAdapter } from '../../inference-presets/exl3-preset-adapter.ts';
import { toError } from '../../lib/errors.ts';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.ts';
import type { TokenEncodeBody } from '../../llm-protocol/inference-client.ts';
import { z } from '../../lib/zod.ts';
import { readConfig } from '../config-store.ts';
import { readBody, sendBodyReadError, sendJson } from '../http-utils.ts';
import { ChatStreamField, ChatStreamOptionsField } from '../passthrough-chat-prompt.ts';
import { RouteTable, type RouteEndpoint } from '../route-table.ts';
import {
  BENCH_REQUEST_KIND,
  MODEL_QUEUE_TIMEOUT_MESSAGE,
  acquireModelRequestWithWait,
  previewModelRequestTarget,
  releaseModelRequest,
} from '../server-ops.ts';
import type { ModelRequestLock, ServerContext } from '../server-types.ts';
import { assertResidentMatches, TabbyModelClient, type TabbyModelCard } from '../tabby-model-client.ts';
import {
  CHAT_PATH as UPSTREAM_CHAT_PATH,
  parseRequestBody,
  proxyStreamingRequest,
  readUsageOptIn,
  requestTokenEncode,
} from './inference-passthrough.ts';

const MODELS_PATH = `${BENCH_ROUTE_PREFIX}/models`;
const CHAT_PATH = `${BENCH_ROUTE_PREFIX}/chat/completions`;
const TOKEN_ENCODE_PATH = `${BENCH_ROUTE_PREFIX}/token/encode`;
const IDENTITY_PATH = `${BENCH_ROUTE_PREFIX}/identity`;
const RUNTIME_REQUIRED_MESSAGE = 'The benchmark route requires the managed inference runtime.';

/** Plain text, or chat messages the engine renders through the preset's chat template. */
const BenchTokenEncodeBodySchema = z.strictObject({
  model: z.string().min(1),
  text: z.union([z.string(), z.array(JsonObjectSchema)]),
  chat_template_kwargs: JsonObjectSchema.optional(),
});

/** Only the fields the route reads or rewrites; everything else reaches the engine untouched. */
const BenchChatBodySchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: ChatStreamField,
  stream_options: ChatStreamOptionsField,
}).catchall(JsonValueSchema);

export function benchResidencyHash(ctx: ServerContext, preset: ModelRuntimePreset): string {
  return createHash('sha256').update(ctx.modelRuntime.getPresetResidencyKey(preset)).digest('hex').slice(0, 16);
}

function residencyHeaders(ctx: ServerContext, preset: ModelRuntimePreset): OutgoingHttpHeaders {
  return {
    [BENCH_RESIDENCY_HEADER]: benchResidencyHash(ctx, preset),
    [BENCH_GENERATION_HEADER]: String(ctx.modelRuntime.getGeneration()),
  };
}

/** What an admitted bench request may forward with; the endpoint's finally releases the lock. */
type AdmittedBenchRequest = { lock: ModelRequestLock; preset: ModelRuntimePreset; baseUrl: string };

/** Admits a benchmark request for one saved preset; answers the response itself and returns null when it cannot. */
async function admitBenchRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  presetId: string,
): Promise<AdmittedBenchRequest | null> {
  if (!ctx.presetRuntimeCoordinator) {
    sendJson(res, 503, { error: RUNTIME_REQUIRED_MESSAGE });
    return null;
  }
  const intent = { presetId: null, model: null, modelPresetId: presetId };
  try {
    previewModelRequestTarget(ctx, intent);
  } catch (error) {
    sendJson(res, 400, { error: toError(error).message });
    return null;
  }
  let lock: ModelRequestLock | null;
  try {
    // A model load can take minutes; the caller's own timeout bounds the wait.
    lock = await acquireModelRequestWithWait(ctx, BENCH_REQUEST_KIND, req, res, { intent, queueTimeout: 'none' });
  } catch (error) {
    sendJson(res, 502, { error: toError(error).message });
    return null;
  }
  if (!lock) {
    if (!res.writableEnded && !res.destroyed) sendJson(res, 503, { error: MODEL_QUEUE_TIMEOUT_MESSAGE });
    return null;
  }
  const preset = lock.context.modelPreset;
  if (!preset.BaseUrl) {
    releaseModelRequest(ctx, lock.token);
    sendJson(res, 503, { error: `Model preset '${preset.id}' has no BaseUrl.` });
    return null;
  }
  return { lock, preset, baseUrl: preset.BaseUrl };
}

class BenchModelsEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
    const presets = readConfig(ctx.configPath).Server.ModelPresets.Presets;
    sendJson(res, 200, { object: 'list', data: presets.map((preset) => ({ id: preset.id, object: 'model' })) });
  }
}

class BenchChatEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: z.infer<typeof BenchChatBodySchema>;
    try {
      body = parseRequestBody(await readBody(req), BenchChatBodySchema);
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    if (maxTokens === undefined) {
      sendJson(res, 400, { error: 'Benchmark requests must set max_tokens.' });
      return;
    }
    const admitted = await admitBenchRequest(ctx, req, res, body.model);
    if (admitted === null) return;
    const { lock, preset, baseUrl } = admitted;
    try {
      const modelName = preset.Model ?? preset.id;
      const forwarded = { ...body, model: modelName, max_tokens: maxTokens };
      delete forwarded.max_completion_tokens;
      const requestId = randomUUID();
      await proxyStreamingRequest(ctx, req, res, baseUrl, UPSTREAM_CHAT_PATH, JSON.stringify(forwarded), {
        identity: {
          operationType: 'evaluation',
          operationId: requestId,
          requestId,
          stage: 'bench_chat_completions',
          model: modelName,
          presetId: preset.id,
        },
        usageOptIn: readUsageOptIn(body),
      }, residencyHeaders(ctx, preset));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: toError(error).message });
      else res.destroy(toError(error));
    } finally {
      releaseModelRequest(ctx, lock.token);
    }
  }
}

class BenchTokenEncodeEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: z.infer<typeof BenchTokenEncodeBodySchema>;
    try {
      body = parseRequestBody(await readBody(req), BenchTokenEncodeBodySchema);
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    const admitted = await admitBenchRequest(ctx, req, res, body.model);
    if (admitted === null) return;
    const { lock, baseUrl } = admitted;
    try {
      const encodeBody: TokenEncodeBody = typeof body.text === 'string'
        ? { text: body.text }
        : { text: body.text, chat_template_kwargs: body.chat_template_kwargs ?? {} };
      const encoded = await requestTokenEncode(res, { baseUrl, authorization: req.headers.authorization }, encodeBody);
      // Only the count: a long prompt's token ids are megabytes the harness never reads.
      if (encoded !== null) sendJson(res, 200, { length: encoded.length });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: toError(error).message });
    } finally {
      releaseModelRequest(ctx, lock.token);
    }
  }
}

/** The card as the contract reports it; null when the engine reports no applied parameters. */
function toResidentCard(card: TabbyModelCard | null): BenchResidentCard | null {
  if (card === null || card.parameters === null || card.parameters === undefined) return null;
  const { max_seq_len, cache_size, chunk_size, cache_mode } = card.parameters;
  return { id: card.id, max_seq_len, cache_size, chunk_size, cache_mode: cache_mode ?? null };
}

/** True when the resident card is exactly what this preset loads; reuses the runtime's own check. */
function residentMatches(card: TabbyModelCard | null, preset: ModelRuntimePreset, modelRoot: string): boolean {
  try {
    assertResidentMatches(card, new Exl3PresetAdapter(modelRoot).buildLoadRequest(preset));
    return true;
  } catch {
    return false;
  }
}

class BenchIdentityEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let model: string;
    try {
      model = parseRequestBody(await readBody(req), BenchIdentityRequestSchema).model;
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    let preset: ModelRuntimePreset;
    try {
      preset = previewModelRequestTarget(ctx, { presetId: null, model: null, modelPresetId: model }).modelPreset;
    } catch (error) {
      sendJson(res, 400, { error: toError(error).message });
      return;
    }
    const engine = readConfig(ctx.configPath).Server.Engines.Exl3;
    const runtime = ctx.modelRuntime;
    const applied = ctx.appliedModelPresetState.getPreset();
    const sameResidency = runtime.getModelState() === 'ready'
      && runtime.getPresetResidencyKey(preset) === runtime.getPresetResidencyKey(applied);
    let card: TabbyModelCard | null = null;
    if (sameResidency && preset.BaseUrl) {
      try {
        card = await new TabbyModelClient(engine.AdminApiKey)
          .getResidentModel(new URL(preset.BaseUrl).origin, preset.HealthcheckTimeoutMs);
      } catch (error) {
        sendJson(res, 503, { error: `The engine did not answer its model card: ${toError(error).message}` });
        return;
      }
    }
    const managed = engine.Managed && !preset.ExternalServerEnabled;
    const matches = sameResidency && residentMatches(card, preset, engine.ModelRoot);
    sendJson(res, 200, BenchIdentityResponseSchema.parse({
      requested: { presetId: preset.id, settings: preset },
      resident: { matches, card: matches ? toResidentCard(card) : null },
      // A managed load of a drafting preset already asserted the engine's drafting log line.
      drafting: { configured: preset.SpeculativeEnabled, verified: matches && managed && preset.SpeculativeEnabled ? true : null },
      engine: {
        managed,
        pythonPath: engine.PythonPath,
        workingDirectory: engine.WorkingDirectory,
        entrypoint: engine.Entrypoint,
        environment: engine.Environment,
      },
      residency: { keyHash: benchResidencyHash(ctx, preset), generation: runtime.getGeneration() },
    }));
  }
}

const ROUTES = new RouteTable([
  { method: 'GET', path: MODELS_PATH, endpoint: new BenchModelsEndpoint() },
  { method: 'POST', path: CHAT_PATH, endpoint: new BenchChatEndpoint() },
  { method: 'POST', path: TOKEN_ENCODE_PATH, endpoint: new BenchTokenEncodeEndpoint() },
  { method: 'POST', path: IDENTITY_PATH, endpoint: new BenchIdentityEndpoint() },
]);

export async function handleBenchRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(`${BENCH_ROUTE_PREFIX}/`)) return false;
  if (await ROUTES.handle(ctx, req, res, pathname)) return true;
  if (ROUTES.hasPath(pathname)) sendJson(res, 405, { error: 'Method not allowed.' });
  else sendJson(res, 404, { error: 'Not found' });
  return true;
}