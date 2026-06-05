#!/usr/bin/env node
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

type Dict = Record<string, unknown>;
type DebugMode = 'both' | 'matrix' | 'thinking-on' | 'thinking-off';

export type ScenarioDefinition = {
  name: string;
  enableThinking: boolean | null;
  reasoningContent: boolean;
  preserveThinking: boolean;
};

export type DebugWebDecisionOptions = {
  baseUrl: string;
  model: string;
  prompt: string;
  mode: DebugMode;
  timeoutMs: number;
  maxTokens: number;
  logFile: string;
  configPath: string;
};

type ParseSources = {
  cwd: string;
  env: Record<string, string | undefined>;
  config: Dict;
};

type ScenarioResult = {
  scenario: string;
  enableThinking: boolean | null;
  reasoningContent: boolean;
  preserveThinking: boolean;
  ok: boolean;
  statusCode: number | null;
  terminalState: string;
  durationMs: number;
  sawDone: boolean;
  dataPacketCount: number;
  rawBytes: number;
  thinkingChars: number;
  answerChars: number;
  firstDataPacket: string;
  errorMessage: string | null;
  errorCode: string | null;
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:8097';
const DEFAULT_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const DEFAULT_PROMPT = 'What do you know about osrs iron bars?';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_SYSTEM_PROMPT = 'general, coder friendly assistant';
const WEB_CHAT_DECISION_PROMPT = [
  'You have live web access via tools. Decide the single next step and respond with exactly one JSON object, no markdown, no prose:',
  'To search the web: {"action":"web_search","query":"...","timeFilter":"week"}',
  'To fetch a public URL: {"action":"web_fetch","url":"https://example.com/page"}',
  'To answer the user now: {"action":"answer"}',
  'Any value that can change over time MUST be verified with web_search before answering - for example: live or Grand Exchange / market item prices, currency and crypto exchange rates, stock quotes, breaking news and current events, weather, sports scores and standings, release dates, and the latest version of software or libraries.',
  'Use stable, well-known static facts directly via {"action":"answer"} without searching.',
  'Private, local, and internal URLs are blocked.',
].join('\n');

function asDict(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {};
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function getConfigPath(cwd: string, env: Record<string, string | undefined>, explicitPath: string): string {
  if (explicitPath.trim()) {
    return path.resolve(cwd, explicitPath.trim());
  }
  const envPath = getString(env.SIFTKIT_CONFIG_PATH);
  return envPath ? path.resolve(cwd, envPath) : path.join(cwd, '.siftkit', 'config.json');
}

function getRuntimeConfig(config: Dict): { baseUrl: string; model: string } {
  const runtime = asDict(config.Runtime);
  const llama = asDict(runtime.LlamaCpp);
  return {
    baseUrl: getString(llama.BaseUrl) || DEFAULT_BASE_URL,
    model: getString(runtime.Model) || DEFAULT_MODEL,
  };
}

function parseMode(value: string): DebugMode {
  if (value === 'both' || value === 'matrix' || value === 'thinking-on' || value === 'thinking-off') {
    return value;
  }
  throw new Error('--mode must be one of: both, matrix, thinking-on, thinking-off.');
}

export function parseArgs(argv: string[], sources: ParseSources = {
  cwd: process.cwd(),
  env: process.env,
  config: {},
}): DebugWebDecisionOptions {
  const configDefaults = getRuntimeConfig(sources.config);
  const parsed: DebugWebDecisionOptions = {
    baseUrl: configDefaults.baseUrl,
    model: configDefaults.model,
    prompt: DEFAULT_PROMPT,
    mode: 'both',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTokens: DEFAULT_MAX_TOKENS,
    logFile: '',
    configPath: getConfigPath(sources.cwd, sources.env, ''),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Expected value after ${token}.`);
      }
      return value;
    };
    if (token === '--base-url') {
      parsed.baseUrl = next().replace(/\/$/u, '');
    } else if (token === '--model') {
      parsed.model = next();
    } else if (token === '--prompt') {
      parsed.prompt = next();
    } else if (token === '--mode') {
      parsed.mode = parseMode(next());
    } else if (token === '--timeout-ms') {
      parsed.timeoutMs = getPositiveInteger(next(), DEFAULT_TIMEOUT_MS);
    } else if (token === '--max-tokens') {
      parsed.maxTokens = getPositiveInteger(next(), DEFAULT_MAX_TOKENS);
    } else if (token === '--log-file') {
      parsed.logFile = next();
    } else if (token === '--config') {
      parsed.configPath = getConfigPath(sources.cwd, sources.env, next());
    } else if (token === '--help' || token === '-h') {
      throw new Error([
        'Usage: npm run debug:web-decision -- [options]',
        '--base-url <url>       llama.cpp base URL. Defaults to Runtime.LlamaCpp.BaseUrl or http://127.0.0.1:8097',
        '--model <id>           model id. Defaults to Runtime.Model or Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        '--prompt <text>        user prompt to simulate',
        '--mode <mode>          both | matrix | thinking-on | thinking-off',
        '--timeout-ms <ms>      request timeout',
        '--max-tokens <n>       max_tokens for the decision call',
        '--log-file <path>      optional JSONL output path',
        '--config <path>        config JSON path. Defaults to SIFTKIT_CONFIG_PATH or .siftkit/config.json',
      ].join('\n'));
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!parsed.baseUrl.startsWith('http://') && !parsed.baseUrl.startsWith('https://')) {
    throw new Error('--base-url must start with http:// or https://.');
  }
  return parsed;
}

export function buildScenarioRequestBody(options: DebugWebDecisionOptions, scenarioDefinition: ScenarioDefinition | boolean): Dict {
  const scenario = typeof scenarioDefinition === 'boolean'
    ? {
      name: scenarioDefinition ? 'thinking-on-full' : 'thinking-off-explicit',
      enableThinking: scenarioDefinition,
      reasoningContent: scenarioDefinition,
      preserveThinking: scenarioDefinition,
    }
    : scenarioDefinition;
  const chatTemplateKwargs: Dict | null = scenario.enableThinking === null
    ? null
    : { enable_thinking: scenario.enableThinking };
  if (chatTemplateKwargs && scenario.reasoningContent) {
    chatTemplateKwargs.reasoning_content = true;
  }
  if (chatTemplateKwargs && scenario.preserveThinking) {
    chatTemplateKwargs.preserve_thinking = true;
  }
  return {
    model: options.model,
    messages: [
      { role: 'system', content: `${DEFAULT_SYSTEM_PROMPT}\n\n${WEB_CHAT_DECISION_PROMPT}` },
      { role: 'user', content: options.prompt },
    ],
    stream: true,
    cache_prompt: true,
    max_tokens: options.maxTokens,
    ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
  };
}

function getErrorCode(error: unknown): string | null {
  const source = asDict(error);
  return typeof source.code === 'string' ? source.code : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function parseDeltaText(packet: string): { thinking: string; answer: string } {
  const lines = packet.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const dataLine = lines.find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return { thinking: '', answer: '' };
  }
  const dataValue = dataLine.slice(5).trim();
  if (dataValue === '[DONE]') {
    return { thinking: '', answer: '' };
  }
  try {
    const parsed = JSON.parse(dataValue) as Dict;
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const choice = asDict(choices[0]);
    const delta = asDict(choice.delta);
    return {
      thinking: getString(delta.reasoning_content),
      answer: getString(delta.content),
    };
  } catch {
    return { thinking: '', answer: '' };
  }
}

function writeJsonLine(logFile: string, value: Dict): void {
  if (!logFile.trim()) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`, 'utf8');
}

export function runScenario(options: DebugWebDecisionOptions, scenario: ScenarioDefinition): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const requestBody = buildScenarioRequestBody(options, scenario);
  const target = new URL(`${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`);
  const transport = target.protocol === 'https:' ? https : http;
  writeJsonLine(options.logFile, { at: new Date().toISOString(), scenario: scenario.name, kind: 'request', body: requestBody });

  return new Promise((resolve) => {
    let settled = false;
    let statusCode: number | null = null;
    let rawBuffer = '';
    let rawBytes = 0;
    let dataPacketCount = 0;
    let thinkingChars = 0;
    let answerChars = 0;
    let firstDataPacket = '';
    let sawDone = false;

    const finish = (terminalState: string, error: unknown = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      const result: ScenarioResult = {
        scenario: scenario.name,
        enableThinking: scenario.enableThinking,
        reasoningContent: scenario.reasoningContent,
        preserveThinking: scenario.preserveThinking,
        ok: terminalState === 'done' || terminalState === 'end_after_done',
        statusCode,
        terminalState,
        durationMs: Date.now() - startedAt,
        sawDone,
        dataPacketCount,
        rawBytes,
        thinkingChars,
        answerChars,
        firstDataPacket,
        errorMessage: error ? getErrorMessage(error) : null,
        errorCode: error ? getErrorCode(error) : null,
      };
      writeJsonLine(options.logFile, { at: new Date().toISOString(), scenario: scenario.name, kind: 'result', result });
      resolve(result);
    };

    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(requestBody), 'utf8'),
      },
    }, (response) => {
      statusCode = response.statusCode || 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        rawBytes += Buffer.byteLength(chunk, 'utf8');
        rawBuffer += chunk;
        let boundary = rawBuffer.indexOf('\n\n');
        while (boundary >= 0) {
          const packet = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          boundary = rawBuffer.indexOf('\n\n');
          if (!packet.trim()) {
            continue;
          }
          dataPacketCount += 1;
          if (!firstDataPacket) {
            firstDataPacket = packet.slice(0, 500);
          }
          if (packet.includes('data: [DONE]')) {
            sawDone = true;
            continue;
          }
          const delta = parseDeltaText(packet);
          thinkingChars += delta.thinking.length;
          answerChars += delta.answer.length;
          writeJsonLine(options.logFile, { at: new Date().toISOString(), scenario: scenario.name, kind: 'packet', packet });
        }
      });
      response.on('aborted', () => {
        finish(sawDone ? 'end_after_done' : 'response_aborted', new Error('response aborted before DONE'));
      });
      response.on('error', (error: Error) => {
        finish(sawDone ? 'end_after_done' : 'response_error', error);
      });
      response.on('end', () => {
        finish(sawDone ? 'done' : 'end_before_done');
      });
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${options.timeoutMs}ms`));
    });
    request.on('error', (error: Error) => {
      finish('request_error', error);
    });
    request.write(JSON.stringify(requestBody));
    request.end();
  });
}

function readConfigFile(configPath: string): Dict {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Dict;
  } catch {
    return {};
  }
}

export function getScenarioDefinitions(mode: DebugMode): ScenarioDefinition[] {
  const thinkingOff: ScenarioDefinition = {
    name: 'thinking-off',
    enableThinking: null,
    reasoningContent: false,
    preserveThinking: false,
  };
  const thinkingOffExplicit: ScenarioDefinition = {
    name: 'thinking-off-explicit',
    enableThinking: false,
    reasoningContent: false,
    preserveThinking: false,
  };
  const thinkingOnBasic: ScenarioDefinition = {
    name: 'thinking-on-basic',
    enableThinking: true,
    reasoningContent: false,
    preserveThinking: false,
  };
  const thinkingOnReasoning: ScenarioDefinition = {
    name: 'thinking-on-reasoning-content',
    enableThinking: true,
    reasoningContent: true,
    preserveThinking: false,
  };
  const thinkingOnPreserve: ScenarioDefinition = {
    name: 'thinking-on-preserve-thinking',
    enableThinking: true,
    reasoningContent: false,
    preserveThinking: true,
  };
  const thinkingOnFull: ScenarioDefinition = {
    name: 'thinking-on-full',
    enableThinking: true,
    reasoningContent: true,
    preserveThinking: true,
  };
  if (mode === 'thinking-on') {
    return [thinkingOnFull];
  }
  if (mode === 'thinking-off') {
    return [thinkingOff];
  }
  if (mode === 'matrix') {
    return [thinkingOff, thinkingOffExplicit, thinkingOnBasic, thinkingOnReasoning, thinkingOnPreserve, thinkingOnFull];
  }
  return [thinkingOff, thinkingOnFull];
}

function printResult(result: ScenarioResult): void {
  const parts = [
    `[${result.scenario}]`,
    result.ok ? 'ok' : 'fail',
    `state=${result.terminalState}`,
    `status=${result.statusCode ?? 'none'}`,
    `done=${result.sawDone}`,
    `packets=${result.dataPacketCount}`,
    `thinking_chars=${result.thinkingChars}`,
    `answer_chars=${result.answerChars}`,
    `bytes=${result.rawBytes}`,
    `duration_ms=${result.durationMs}`,
  ];
  if (result.errorMessage) {
    parts.push(`error=${result.errorMessage}`);
  }
  if (result.errorCode) {
    parts.push(`code=${result.errorCode}`);
  }
  process.stdout.write(`${parts.join(' ')}\n`);
  if (result.firstDataPacket) {
    process.stdout.write(`[${result.scenario}] first_packet=${result.firstDataPacket.replace(/\r?\n/gu, '\\n')}\n`);
  }
}

async function main(): Promise<void> {
  const firstPass = parseArgs(process.argv.slice(2), { cwd: process.cwd(), env: process.env, config: {} });
  const config = readConfigFile(firstPass.configPath);
  const options = parseArgs(process.argv.slice(2), { cwd: process.cwd(), env: process.env, config });
  process.stdout.write(`base_url=${options.baseUrl} model=${options.model} config=${options.configPath}\n`);
  if (options.logFile) {
    process.stdout.write(`log_file=${path.resolve(options.logFile)}\n`);
  }
  for (const scenario of getScenarioDefinitions(options.mode)) {
    const result = await runScenario(options, scenario);
    printResult(result);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
