import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';

import type {
  EngineLaunchSpec, EngineProcess, EngineProcessLauncher, ManagedEngineHost,
} from '../../src/status-server/engine-process.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { JsonObjectSchema, type JsonValue } from '../../src/lib/json-types.js';
import { z } from '../../src/lib/zod.js';
import { buildTabbyUsage } from './streaming-client.js';

export type FakeTabbyOptions = {
  port: number;
  /** Listed by `/v1/models`, and the card id when the launch environment names no model. */
  modelId?: string;
  /** `GET /v1/model` answers "no model loaded" this many times before reporting the card. */
  initialUnloadedModelProbeCount?: number;
  tokenizeCharsPerToken?: number;
  /** Reported instead of the requested context, like a server that silently clamps it. */
  appliedMaxSeqLen?: number;
  /** `POST /v1/model/load` fails with 500 instead of loading. */
  rejectLoads?: boolean;
  /** Announces MTP drafting when the launch asks for it; loguru writes to stderr by default. */
  mtpAnnouncement?: { stream: 'stdout' | 'stderr'; delayMs: number };
  startupLogLine?: string;
  engineLogLine?: string;
  /** Written to stderr once `releaseDeferredLog()` is called. */
  deferredLogLine?: string;
  /** Starts but never serves, like an engine wedged during startup. */
  launchHangingProcess?: boolean;
  /** Logs `engineLogLine`, then exits with `exitCode` before serving. */
  exitAfterLog?: boolean;
  exitCode?: number;
};

const FakeEngineSteeringSchema = z.object({
  usage: JsonObjectSchema.nullable().optional(),
  padding_chars: z.number().optional(),
  finish_delay_ms: z.number().optional(),
}).loose();

const ForwardedRequestSchema = z.object({
  stream: z.boolean().optional(),
  fake_engine: FakeEngineSteeringSchema.optional(),
}).loose();

const LoadRequestSchema = z.object({
  model_name: z.string().optional(),
  max_seq_len: z.number().optional(),
  cache_size: z.number().optional(),
  chunk_size: z.number().optional(),
}).loose();

const EncodeRequestSchema = z.object({ text: z.string().optional() }).loose();

type ModelCard = { id: string; parameters: { max_seq_len: number; cache_size: number; chunk_size: number } };

// Self-consistent Tabby usage: reported rates equal count / time, so the audit stays quiet.
const DEFAULT_USAGE = buildTabbyUsage({ promptTokens: 3, completionTokens: 1 });

let nextFakePid = 900_000;

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function parseBody(text: string): JsonValue {
  try {
    return parseJsonValueText(text || 'null');
  } catch {
    return null;
  }
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: object): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

class FakeTabbyProcess extends EventEmitter implements EngineProcess {
  readonly pid = nextFakePid++;
  exitCode: number | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private server: http.Server | null = null;

  constructor(readonly spec: EngineLaunchSpec) {
    super();
  }

  get serving(): boolean {
    return this.server?.listening === true;
  }

  listen(handler: http.RequestListener, port: number, onListening: () => void): void {
    const server = http.createServer(handler);
    this.server = server;
    server.on('error', (error) => this.emit('error', error));
    server.listen(port, '127.0.0.1', onListening);
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    const server = this.server;
    this.server = null;
    const finish = (): void => {
      this.exitCode = code;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', code, null);
    };
    if (server === null) {
      setImmediate(finish);
      return;
    }
    server.closeAllConnections();
    server.close(() => finish());
  }
}

/**
 * Fake TabbyAPI that runs inside the test process: each launch serves the Tabby HTTP surface on
 * the configured loopback port, and terminate closes it and reports the exit like a real child.
 * The model card comes from the `TABBY_MODEL_*` launch environment or the last `/v1/model/load`.
 */
export class FakeTabbyLauncher implements EngineProcessLauncher {
  readonly launches: EngineLaunchSpec[] = [];
  loadRequestCount = 0;
  modelProbeCount = 0;
  private readonly processes: FakeTabbyProcess[] = [];
  private deferredLogReleased = false;

  constructor(private readonly options: FakeTabbyOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  /** True while the latest launch is alive and serving HTTP. */
  get serving(): boolean {
    return this.processes.some((process) => process.serving);
  }

  get liveProcessCount(): number {
    return this.processes.filter((process) => process.exitCode === null).length;
  }

  releaseDeferredLog(): void {
    this.deferredLogReleased = true;
    const line = this.options.deferredLogLine;
    if (!line) return;
    for (const process of this.processes) if (process.exitCode === null) process.stderr.write(`${line}\n`);
  }

  launch(spec: EngineLaunchSpec): EngineProcess {
    this.launches.push(spec);
    const process = new FakeTabbyProcess(spec);
    this.processes.push(process);
    setImmediate(() => this.start(process));
    return process;
  }

  terminate(engineProcess: EngineProcess): void {
    for (const process of this.processes) if (process === engineProcess) process.exit(0);
  }

  /** Stops every launch still alive; for test teardown. */
  stopAll(): Promise<void> {
    const live = this.processes.filter((process) => process.exitCode === null);
    return Promise.all(live.map((process) => new Promise<void>((resolve) => {
      process.once('exit', () => resolve());
      process.exit(0);
    }))).then(() => undefined);
  }

  private start(process: FakeTabbyProcess): void {
    const options = this.options;
    if (options.startupLogLine) process.stdout.write(`${options.startupLogLine}\n`);
    if (options.exitAfterLog) {
      if (options.engineLogLine) process.stdout.write(`${options.engineLogLine}\n`);
      process.exit(options.exitCode ?? 0);
      return;
    }
    if (options.launchHangingProcess) return;
    const environment = process.spec.environment;
    const card = { current: this.initialCard(environment) };
    let unloadedProbes = options.initialUnloadedModelProbeCount ?? 0;
    process.listen((request, response) => {
      void this.handle(request, response, card, () => {
        if (unloadedProbes > 0) {
          unloadedProbes -= 1;
          return false;
        }
        return true;
      });
    }, options.port, () => {
      if (options.engineLogLine) process.stdout.write(`${options.engineLogLine}\n`);
      if (options.deferredLogLine && this.deferredLogReleased) process.stderr.write(`${options.deferredLogLine}\n`);
      const announcement = options.mtpAnnouncement;
      if (announcement && environment.TABBY_DRAFT_MODEL_DRAFT_MODE === 'mtp') {
        setTimeout(() => {
          process[announcement.stream].write('INFO: Using main model MTP component for drafting\n');
        }, announcement.delayMs);
      }
    });
  }

  private initialCard(environment: EngineLaunchSpec['environment']): ModelCard | null {
    const modelName = environment.TABBY_MODEL_MODEL_NAME;
    if (!modelName) return null;
    return {
      id: modelName,
      parameters: {
        max_seq_len: this.options.appliedMaxSeqLen ?? Number(environment.TABBY_MODEL_MAX_SEQ_LEN),
        cache_size: Number(environment.TABBY_MODEL_CACHE_SIZE),
        chunk_size: Number(environment.TABBY_MODEL_CHUNK_SIZE),
      },
    };
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    card: { current: ModelCard | null },
    probeReportsCard: () => boolean,
  ): Promise<void> {
    const url = request.url || '';
    const modelId = this.options.modelId ?? 'managed-test-model';
    if (request.method === 'GET' && url === '/v1/models') {
      // TabbyAPI lists the models available under the model directory, loaded or not.
      sendJson(response, 200, { object: 'list', data: [{ id: modelId, object: 'model' }] });
      return;
    }
    if (request.method === 'GET' && url === '/v1/model') {
      this.modelProbeCount += 1;
      if (probeReportsCard() && card.current) {
        sendJson(response, 200, card.current);
        return;
      }
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('No models are currently loaded');
      return;
    }
    if (request.method === 'POST' && url === '/v1/model/load') {
      this.loadRequestCount += 1;
      const body = LoadRequestSchema.catch({}).parse(parseBody(await readBody(request)));
      if (this.options.rejectLoads) {
        response.statusCode = 500;
        response.end();
        return;
      }
      card.current = {
        id: body.model_name ?? modelId,
        parameters: {
          max_seq_len: this.options.appliedMaxSeqLen ?? Number(body.max_seq_len),
          cache_size: Number(body.cache_size),
          chunk_size: Number(body.chunk_size),
        },
      };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      return;
    }
    if (request.method === 'POST' && url === '/v1/model/unload') {
      card.current = null;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url === '/v1/token/encode') {
      const text = EncodeRequestSchema.catch({}).parse(parseBody(await readBody(request))).text ?? '';
      const count = text.trim() ? Math.max(1, Math.ceil(text.length / (this.options.tokenizeCharsPerToken ?? 4))) : 0;
      sendJson(response, 200, { tokens: Array.from({ length: count }, (_, index) => index + 1), length: count });
      return;
    }
    if (request.method === 'POST' && url === '/v1/chat/completions') {
      const bodyText = await readBody(request);
      const forwardedRequest = ForwardedRequestSchema.catch({}).parse(parseBody(bodyText));
      // Caller steers the fake via fake_engine: usage (null omits it), padding_chars, finish_delay_ms.
      const steering = forwardedRequest.fake_engine ?? {};
      const usage = steering.usage === undefined ? DEFAULT_USAGE : steering.usage;
      if (forwardedRequest.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (payload: object): string => `data: ${JSON.stringify(payload)}\n\n`;
        response.write(frame({ choices: [{ delta: { content: `ok${'x'.repeat(steering.padding_chars ?? 0)}` } }] }));
        const finish = (): void => {
          response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
          if (usage) response.write(frame({ choices: [], usage }));
          response.end('data: [DONE]\n\n');
        };
        const delay = steering.finish_delay_ms ?? 0;
        if (delay > 0) setTimeout(finish, delay); else finish();
        return;
      }
      sendJson(response, 200, {
        choices: [{ message: { content: 'ok' } }],
        ...(usage ? { usage } : {}),
        forwardedRequest: parseBody(bodyText),
      });
      return;
    }
    if (request.method === 'GET' && url === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }
}

/** The engine-facing variables a launch carried, as the old child-side recorder filtered them. */
export function launchEngineVariables(spec: EngineLaunchSpec | undefined): Record<string, string> {
  if (!spec) throw new Error('The fake engine was never launched.');
  return Object.fromEntries(Object.entries(spec.environment).flatMap(([key, value]) => (
    value !== undefined && /^(?:TABBY_|EXL3_|PYTORCH_)/u.test(key) ? [[key, value]] : []
  )));
}

/** For runtimes that must never launch: a launch or interpreter probe fails the test loudly. */
export const NEVER_LAUNCHING_ENGINE_HOST: ManagedEngineHost = {
  launcher: {
    launch(spec) {
      throw new Error(`Unexpected managed engine launch: ${spec.command}`);
    },
    terminate() {
      throw new Error('Unexpected managed engine termination.');
    },
  },
  packageLocator: {
    inspectPackage(pythonPath) {
      throw new Error(`Unexpected EXL3 interpreter probe: ${pythonPath}`);
    },
  },
};
