#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadConfig,
  getConfiguredModel,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getEffectiveInputCharactersPerContextToken,
} = require('../dist/config.js');
const { listLlamaCppModels, countLlamaCppTokens } = require('../dist/providers/llama-cpp.js');

const DEFAULT_MAX_TURNS = 45;
const DEFAULT_MAX_INVALID_RESPONSES = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;
const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const PER_TOOL_RESULT_RATIO = 0.10;
const DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS = 2048;
const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
const FORCED_FINISH_MAX_ATTEMPTS = 3;

function createJsonlLogger(filePath) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '', 'utf8');
  return {
    path: target,
    write(event) {
      fs.appendFileSync(
        target,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8'
      );
    },
  };
}

/**
 * @typedef {{ action: 'tool', tool_name: 'run_repo_cmd', args: { command: string } }} ToolAction
 * @typedef {{ action: 'finish', output: string, confidence?: number }} FinishAction
 * @typedef {ToolAction | FinishAction} MockPlannerAction
 * @typedef {{
 *   runId: string,
 *   model: string,
 *   tasks: TaskResult[],
 *   totals: {
 *     tasks: number,
 *     passed: number,
 *     failed: number,
 *     commandsExecuted: number,
 *     safetyRejects: number,
 *     invalidResponses: number,
 *   },
 *   verdict: 'pass' | 'fail',
 *   failureReasons: string[],
 * }} Scorecard
 * @typedef {{
 *   id: string,
 *   question: string,
 *   signals: string[],
 * }} TaskDefinition
 * @typedef {{
 *   command: string,
 *   safe: boolean,
 *   reason: string | null,
 *   exitCode: number | null,
 *   output: string,
 * }} TaskCommand
 * @typedef {{
 *   id: string,
 *   question: string,
 *   reason: 'finish' | 'max_turns' | 'invalid_response_limit' | 'mock_responses_exhausted' | 'forced_finish_attempt_limit',
 *   turnsUsed: number,
 *   safetyRejects: number,
 *   invalidResponses: number,
 *   commands: TaskCommand[],
 *   finalOutput: string,
 *   passed: boolean,
 *   missingSignals: string[],
 * }} TaskResult
 */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'run_repo_cmd',
      description: 'Run one read-only repo command to inspect files. Command must be non-mutating.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

const TASK_PACK = [
  {
    id: 'symbol-location',
    question: 'Find where buildPlannerToolDefinitions is defined. Return file path and nearby signature text.',
    signals: ['src[\\\\/]summary\\.ts', 'buildPlannerToolDefinitions'],
  },
  {
    id: 'call-path',
    question: 'Find what function invokes invokePlannerMode in summary flow. Return caller function name.',
    signals: ['invokePlannerMode', 'invokeSummaryCore'],
  },
  {
    id: 'config-runtime-key',
    question: 'Find where getConfiguredLlamaNumCtx is defined and at least one usage site.',
    signals: ['src[\\\\/]config\\.ts', 'getConfiguredLlamaNumCtx'],
  },
  {
    id: 'planner-tools',
    question: 'Find planner tool names in SiftKit and list them.',
    signals: ['find_text', 'read_lines', 'json_filter'],
  },
  {
    id: 'debug-artifacts',
    question: 'Find where planner debug dumps are written and show filename pattern.',
    signals: ['planner_debug_', 'getRuntimeLogsPath'],
  },
];

function requestJson(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          if (!responseText.trim()) {
            resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
            return;
          }
          try {
            resolve({
              statusCode: response.statusCode || 0,
              body: JSON.parse(responseText),
              rawText: responseText,
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function plannerGrammar() {
  return [
    'root ::= tool_action | finish_action',
    'tool_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"tool\\"" ws "," ws "\\"tool_name\\"" ws ":" ws "\\"run_repo_cmd\\"" ws "," ws "\\"args\\"" ws ":" ws args_obj ws "}"',
    'args_obj ::= "{" ws "\\"command\\"" ws ":" ws string ws "}"',
    'finish_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"finish\\"" ws "," ws "\\"output\\"" ws ":" ws string (ws "," ws "\\"confidence\\"" ws ":" ws number)? ws "}"',
    'number ::= "-"? int frac? exp?',
    'int ::= "0" | [1-9] [0-9]*',
    'frac ::= "." [0-9]+',
    'exp ::= [eE] [+-]? [0-9]+',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
    'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
    'hex ::= [0-9a-fA-F]',
    'ws ::= [ \\t\\n\\r]*',
  ].join('\n');
}

function finishValidationGrammar() {
  return [
    'root ::= object',
    'object ::= "{" ws "\\"verdict\\"" ws ":" ws verdict ws "," ws "\\"reason\\"" ws ":" ws string ws "}"',
    'verdict ::= "\\"pass\\"" | "\\"fail\\""',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
    'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
    'hex ::= [0-9a-fA-F]',
    'ws ::= [ \\t\\n\\r]*',
  ].join('\n');
}

function actionFromToolCall(choice) {
  const toolCall = choice?.message?.tool_calls?.[0]
    ?? choice?.tool_calls?.[0]
    ?? choice?.message?.function_call
    ?? choice?.function_call;
  const name = typeof toolCall?.function?.name === 'string'
    ? toolCall.function.name
    : typeof toolCall?.name === 'string'
      ? toolCall.name
      : '';
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments;
  if (name !== 'run_repo_cmd') {
    return null;
  }
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.command !== 'string') {
    return null;
  }
  return JSON.stringify({
    action: 'tool',
    tool_name: 'run_repo_cmd',
    args: { command: args.command },
  });
}

function normalizeProviderText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function requestPlannerAction(options) {
  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) {
      return { text: '', thinkingText: '', mockExhausted: true };
    }
    return {
      text: options.mockResponses[index],
      thinkingText: '',
      mockExhausted: false,
      nextMockResponseIndex: index + 1,
    };
  }

  const response = await requestJson({
    url: `${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: options.requestMaxTokens,
      chat_template_kwargs: {
        enable_thinking: options.thinkingEnabled !== false,
      },
      extra_body: {
        grammar: plannerGrammar(),
        tools: TOOL_DEFINITIONS,
        ...(options.thinkingEnabled === false ? { reasoning_budget: 0 } : {}),
      },
    }),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.rawText ? `: ${response.rawText.slice(0, 400)}` : '.';
    throw new Error(`llama.cpp planner request failed with HTTP ${response.statusCode}${detail}`);
  }

  const firstChoice = response.body?.choices?.[0] || {};
  const text = normalizeProviderText(firstChoice?.message?.content)
    || normalizeProviderText(firstChoice?.text)
    || '';
  const thinkingText = normalizeProviderText(firstChoice?.message?.reasoning_content)
    || normalizeProviderText(firstChoice?.reasoning_content)
    || '';
  const synthesized = actionFromToolCall(firstChoice);
  return {
    text: (text || synthesized || '').trim(),
    thinkingText,
    mockExhausted: false,
  };
}

function parseFinishValidationResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider returned an invalid finish validation payload: ${message}`);
  }

  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new Error('Provider returned an invalid finish validation payload.');
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    throw new Error('Provider returned an invalid finish validation payload.');
  }
  return {
    verdict,
    reason: parsed.reason.trim(),
  };
}

function buildFinishValidationPrompt(options) {
  const sections = [
    'You are validating a repo-search answer against gathered evidence.',
    'Return exactly one JSON object: {"verdict":"pass"|"fail","reason":"<short reason>"}',
    'Question: is the answer valid? is the answer well supported/justified?',
    '',
    `Task: ${options.question}`,
    `Proposed answer: ${options.finalOutput}`,
    '',
    'Evidence from tool calls and inserted results:',
    options.evidenceText || '[none]',
  ];
  return sections.join('\n');
}

async function requestFinishValidation(options) {
  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) {
      return { text: '', thinkingText: '', mockExhausted: true };
    }
    return {
      text: options.mockResponses[index],
      thinkingText: '',
      mockExhausted: false,
      nextMockResponseIndex: index + 1,
    };
  }

  const response = await requestJson({
    url: `${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: options.requestMaxTokens,
      chat_template_kwargs: {
        enable_thinking: true,
      },
      extra_body: {
        grammar: finishValidationGrammar(),
      },
    }),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.rawText ? `: ${response.rawText.slice(0, 400)}` : '.';
    throw new Error(`llama.cpp finish validation request failed with HTTP ${response.statusCode}${detail}`);
  }

  const firstChoice = response.body?.choices?.[0] || {};
  const text = normalizeProviderText(firstChoice?.message?.content)
    || normalizeProviderText(firstChoice?.text)
    || '';
  const thinkingText = normalizeProviderText(firstChoice?.message?.reasoning_content)
    || normalizeProviderText(firstChoice?.reasoning_content)
    || '';
  return {
    text: text.trim(),
    thinkingText,
    mockExhausted: false,
  };
}

function buildTerminalSynthesisPrompt(options) {
  const evidenceText = options.history.length > 0
    ? options.history.map((item) => `Command: ${item.command}\nResult: ${item.resultText}`).join('\n\n')
    : '[none]';
  return [
    'You are finalizing a repo-search run that terminated before finish validation passed.',
    'Write a best-effort final answer from available evidence.',
    'Rules:',
    '- Be explicit about uncertainty.',
    '- Include concrete file:line evidence when present.',
    '- Keep it concise and directly answer the task question.',
    '',
    `Task: ${options.question}`,
    `Termination reason: ${options.reason}`,
    '',
    'Evidence from tool calls and inserted results:',
    evidenceText,
  ].join('\n');
}

function buildTerminalSynthesisFallback(options) {
  const lines = [];
  if (options.commands.length > 0) {
    for (let index = options.commands.length - 1; index >= 0; index -= 1) {
      const command = options.commands[index];
      const output = String(command.output || '').trim();
      if (!output) {
        continue;
      }
      const singleLine = output.split(/\r?\n/u).find((line) => line.trim()) || '';
      if (singleLine) {
        lines.push(`Latest evidence (${command.command}): ${singleLine}`);
      }
      if (lines.length >= 2) {
        break;
      }
    }
  }
  if (lines.length === 0) {
    lines.push('No usable evidence was captured from tool calls.');
  }
  return [
    `Best-effort result (terminated: ${options.reason}).`,
    ...lines,
  ].join('\n');
}

async function requestTerminalSynthesis(options) {
  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) {
      return { text: '', thinkingText: '', mockExhausted: true };
    }
    return {
      text: options.mockResponses[index],
      thinkingText: '',
      mockExhausted: false,
      nextMockResponseIndex: index + 1,
    };
  }

  const response = await requestJson({
    url: `${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    method: 'POST',
    timeoutMs: options.timeoutMs,
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: options.requestMaxTokens,
      chat_template_kwargs: {
        enable_thinking: true,
      },
    }),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.rawText ? `: ${response.rawText.slice(0, 400)}` : '.';
    throw new Error(`llama.cpp terminal synthesis request failed with HTTP ${response.statusCode}${detail}`);
  }

  const firstChoice = response.body?.choices?.[0] || {};
  const text = normalizeProviderText(firstChoice?.message?.content)
    || normalizeProviderText(firstChoice?.text)
    || '';
  const thinkingText = normalizeProviderText(firstChoice?.message?.reasoning_content)
    || normalizeProviderText(firstChoice?.reasoning_content)
    || '';
  return {
    text: text.trim(),
    thinkingText,
    mockExhausted: false,
  };
}

function parsePlannerAction(text) {
  const normalized = stripCodeFence(text);
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    const recovered = tryRecoverMalformedPlannerToolAction(normalized);
    if (recovered) {
      return recovered;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider returned an invalid planner payload: ${message}`);
  }

  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  if (action === 'tool') {
    if (
      parsed.tool_name !== 'run_repo_cmd'
      || !parsed.args
      || typeof parsed.args !== 'object'
      || Array.isArray(parsed.args)
      || typeof parsed.args.command !== 'string'
      || !parsed.args.command.trim()
    ) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    return {
      action: 'tool',
      tool_name: 'run_repo_cmd',
      args: { command: parsed.args.command.trim() },
    };
  }

  if (action === 'finish') {
    if (typeof parsed.output !== 'string' || !parsed.output.trim()) {
      throw new Error('Provider returned an invalid planner finish action.');
    }
    const confidence = Number(parsed.confidence);
    return Number.isFinite(confidence)
      ? { action: 'finish', output: parsed.output.trim(), confidence }
      : { action: 'finish', output: parsed.output.trim() };
  }

  throw new Error('Provider returned an unknown planner action.');
}

function decodeJsonStringLoose(raw) {
  let decoded = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      decoded += ch;
      continue;
    }
    if (i + 1 >= raw.length) {
      decoded += '\\';
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    if (next === '"' || next === '\\' || next === '/') {
      decoded += next;
      continue;
    }
    if (next === 'b') {
      decoded += '\b';
      continue;
    }
    if (next === 'f') {
      decoded += '\f';
      continue;
    }
    if (next === 'n') {
      decoded += '\n';
      continue;
    }
    if (next === 'r') {
      decoded += '\r';
      continue;
    }
    if (next === 't') {
      decoded += '\t';
      continue;
    }
    if (next === 'u' && i + 4 < raw.length) {
      const hex = raw.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    // Keep going for non-standard escape sequences by dropping the backslash.
    decoded += next;
  }
  return decoded;
}

function tryRecoverMalformedPlannerToolAction(rawText) {
  if (
    !/"action"\s*:\s*"tool"/iu.test(rawText)
    || !/"tool_name"\s*:\s*"run_repo_cmd"/iu.test(rawText)
  ) {
    return null;
  }
  const commandMatch = /"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*$/u.exec(rawText);
  if (!commandMatch || typeof commandMatch[1] !== 'string') {
    return null;
  }
  const recoveredCommand = decodeJsonStringLoose(commandMatch[1]).trim();
  if (!recoveredCommand) {
    return null;
  }
  return {
    action: 'tool',
    tool_name: 'run_repo_cmd',
    args: { command: recoveredCommand },
  };
}

function hasBlockedOperator(command) {
  return /&&|\|\||[;`]/u.test(command);
}

function splitTopLevelPipes(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === '|' && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function normalizeRepoRoot(repoRoot) {
  return String(repoRoot || '')
    .replace(/\//gu, '\\')
    .replace(/\\+$/u, '')
    .toLowerCase();
}

function tokenizeSegment(segment) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizePathCandidate(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/gu, '');
}

function isPathOutsideRepo(pathCandidate, normalizedRepoRoot) {
  const token = normalizePathCandidate(pathCandidate).replace(/\//gu, '\\');
  if (!token) {
    return false;
  }
  if (/\.\.[\\/]/u.test(token)) {
    return true;
  }
  if (/^\\\\[a-z0-9_.-]+\\/iu.test(token)) {
    return true;
  }
  if (/^[a-zA-Z]:\\/u.test(token)) {
    return token.toLowerCase().startsWith(normalizedRepoRoot) === false;
  }
  return false;
}

function collectOptionPaths(tokens, optionConfig) {
  const paths = [];
  const command = (tokens[0] || '').toLowerCase();
  if (!command) {
    return paths;
  }
  const config = optionConfig[command];
  if (!config) {
    return paths;
  }
  const {
    valueOptions,
    pathOptions,
    positionalArePaths,
    rgPatternOptions,
  } = config;
  let index = 1;
  let rgPatternProvidedByOption = false;
  let rgPatternConsumed = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('-')) {
      const normalized = token.toLowerCase();
      if (valueOptions.has(normalized)) {
        const next = tokens[index + 1];
        if (next) {
          if (pathOptions.has(normalized)) {
            paths.push(next);
          }
          if (command === 'rg' && rgPatternOptions.has(normalized)) {
            rgPatternProvidedByOption = true;
          }
        }
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (command === 'rg') {
      if (!rgPatternProvidedByOption && !rgPatternConsumed) {
        rgPatternConsumed = true;
      } else {
        paths.push(token);
      }
    } else if (positionalArePaths) {
      paths.push(token);
    }
    index += 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (command === 'rg') {
      if (!rgPatternProvidedByOption && !rgPatternConsumed) {
        rgPatternConsumed = true;
      } else {
        paths.push(token);
      }
    } else if (positionalArePaths) {
      paths.push(token);
    }
  }
  return paths;
}

function referencesPathOutsideRepo(command, repoRoot) {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  if (!normalizedRepoRoot) {
    return false;
  }

  const pathOptionConfig = {
    rg: {
      valueOptions: new Set([
        '-e', '--regexp',
        '-f', '--file',
        '-g', '--glob',
        '--iglob',
        '-t', '--type',
        '-t', '--type-not',
        '--type-add',
        '--type-clear',
        '-m', '--max-count',
        '-A', '-B', '-C',
        '--context',
        '--max-filesize',
        '--engine',
        '--encoding',
        '--sort',
        '--sortr',
        '--threads',
      ]),
      pathOptions: new Set(['-f', '--file']),
      positionalArePaths: true,
      rgPatternOptions: new Set(['-e', '--regexp']),
    },
    'get-content': {
      valueOptions: new Set(['-path', '-literalpath', '-encoding', '-delimiter', '-filter', '-include', '-exclude', '-raw', '-readcount', '-totalcount', '-tail']),
      pathOptions: new Set(['-path', '-literalpath']),
      positionalArePaths: true,
      rgPatternOptions: new Set(),
    },
    'get-childitem': {
      valueOptions: new Set(['-path', '-literalpath', '-filter', '-include', '-exclude', '-name', '-file', '-directory', '-recurse', '-depth', '-force']),
      pathOptions: new Set(['-path', '-literalpath']),
      positionalArePaths: true,
      rgPatternOptions: new Set(),
    },
    ls: {
      valueOptions: new Set(['-path', '-literalpath', '-filter', '-include', '-exclude', '-name', '-file', '-directory', '-recurse', '-depth', '-force']),
      pathOptions: new Set(['-path', '-literalpath']),
      positionalArePaths: true,
      rgPatternOptions: new Set(),
    },
    'select-string': {
      valueOptions: new Set(['-path', '-literalpath', '-pattern', '-simplematch', '-encoding', '-caseSensitive', '-allmatches', '-notmatch']),
      pathOptions: new Set(['-path', '-literalpath']),
      positionalArePaths: false,
      rgPatternOptions: new Set(),
    },
  };

  const segments = splitTopLevelPipes(command);
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    const pathCandidates = collectOptionPaths(tokens, pathOptionConfig);
    for (const candidate of pathCandidates) {
      if (isPathOutsideRepo(candidate, normalizedRepoRoot)) {
        return true;
      }
    }
  }
  return false;
}

function hasFileRedirection(command) {
  return /(^|\s)(?:\d?>|>>|<|\*>)($|\s)/u.test(command);
}

function getFirstToken(segment) {
  return (segment.trim().split(/\s+/u)[0] || '').toLowerCase();
}

function getGitSubcommand(segment) {
  const tokens = segment.trim().split(/\s+/u).filter(Boolean);
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i].toLowerCase();
    if (token === '-c' || token === '--git-dir' || token === '--work-tree') {
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    return token;
  }
  return '';
}

function evaluateSegmentSafety(segment, allowedCommands) {
  const token = getFirstToken(segment);
  if (!allowedCommands.has(token)) {
    return { safe: false, reason: `command is not in allowlist: ${token}` };
  }
  if (token === 'git') {
    const subcommand = getGitSubcommand(segment);
    if (subcommand !== 'status' && subcommand !== 'log' && subcommand !== 'show') {
      return { safe: false, reason: 'git subcommand is not in read-only allowlist' };
    }
  }
  return { safe: true, reason: null };
}

function evaluateCommandSafety(command, repoRoot = '') {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { safe: false, reason: 'empty command' };
  }
  if (referencesPathOutsideRepo(trimmed, repoRoot)) {
    return { safe: false, reason: 'command must stay within the caller repository scope' };
  }
  if (hasBlockedOperator(trimmed)) {
    return { safe: false, reason: 'shell chaining/redirection is not allowed' };
  }
  if (hasFileRedirection(trimmed)) {
    return { safe: false, reason: 'file redirection is not allowed' };
  }
  if (/\b(rm|del|mv|cp|move-item|copy-item|remove-item|set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|curl|wget|invoke-webrequest|invoke-restmethod|start-process)\b/iu.test(trimmed)) {
    return { safe: false, reason: 'destructive, file-writing, or network command is not allowed' };
  }

  const segments = splitTopLevelPipes(trimmed);
  const producerCommands = new Set([
    'rg',
    'get-content',
    'get-childitem',
    'select-string',
    'git',
    'pwd',
    'ls',
  ]);
  const pipeCommands = new Set([
    'select-object',
    'select-string',
    'where-object',
    'sort-object',
    'group-object',
    'measure-object',
    'foreach-object',
    'format-table',
    'format-list',
    'out-string',
    'convertto-json',
    'convertfrom-json',
    'get-unique',
    'join-string',
  ]);
  const allAllowedCommands = new Set([...producerCommands, ...pipeCommands]);

  if (segments.length === 1) {
    return evaluateSegmentSafety(segments[0], allAllowedCommands);
  }

  for (const segment of segments) {
    const result = evaluateSegmentSafety(segment, allAllowedCommands);
    if (!result.safe) {
      return result;
    }
    if (
      /\bforeach-object\b/iu.test(segment)
      && /\b(set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|remove-item|move-item|copy-item|rename-item|invoke-webrequest|invoke-restmethod|start-process)\b/iu.test(segment)
    ) {
      return { safe: false, reason: 'ForEach-Object must be read-only' };
    }
  }

  return { safe: true, reason: null };
}

function normalizePlannerCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { command: trimmed, rewritten: false, note: '' };
  }
  if (!/^rg(?:\s|$)/iu.test(trimmed)) {
    return { command: trimmed, rewritten: false, note: '' };
  }

  const hasTsxType = /(?:^|\s)--type\s+tsx\b/iu.test(trimmed);
  if (!hasTsxType) {
    return { command: trimmed, rewritten: false, note: '' };
  }
  if (/(?:^|\s)--glob(?:\s|$)/iu.test(trimmed)) {
    return {
      command: trimmed,
      rewritten: false,
      note: '',
      rejected: true,
      rejectedReason: 'unsupported rg type flag: --type tsx; use --glob "*.tsx" or --type ts',
    };
  }

  const hasTsType = /(?:^|\s)--type\s+ts\b/iu.test(trimmed);
  let rewritten = trimmed
    .replace(/\s--type\s+tsx\b/giu, '')
    .replace(/\s--type\s+ts\b/giu, '');
  rewritten = `${rewritten} --glob "*.tsx"`;
  if (hasTsType) {
    rewritten = `${rewritten} --glob "*.ts"`;
  }
  rewritten = rewritten.trim();

  return {
    command: rewritten,
    rewritten: true,
    note: `note: original command failed compatibility check; ran '${rewritten}' instead`,
  };
}

function executeRepoCommand(command, repoRoot, mockCommandResults) {
  if (mockCommandResults && Object.prototype.hasOwnProperty.call(mockCommandResults, command)) {
    const result = mockCommandResults[command];
    const delayMs = Number(result.delayMs ?? 0);
    return new Promise((resolve) => {
      const complete = () => resolve({
        exitCode: Number(result.exitCode ?? 1),
        output: `${String(result.stdout || '')}${String(result.stderr || '')}`.trim(),
      });
      if (Number.isFinite(delayMs) && delayMs > 0) {
        setTimeout(complete, delayMs);
      } else {
        complete();
      }
    });
  }

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      const outputParts = [];
      if (spawnError) {
        const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        outputParts.push(`spawn_error=${errorCode} message=${message}`);
      }
      const textOutput = `${stdout}${stderr}`.trim();
      if (textOutput) {
        outputParts.push(textOutput);
      }
      resolve({
        exitCode: typeof code === 'number' ? code : (spawnError ? 126 : 1),
        output: outputParts.join('\n').trim(),
      });
    });
  });
}

function buildTaskPrompt(options) {
  const sections = [
    'You are running as a repo-search planner.',
    'Return exactly one JSON action per turn.',
    'Allowed tool: {"action":"tool","tool_name":"run_repo_cmd","args":{"command":"..."}}',
    'Finish format: {"action":"finish","output":"...","confidence":0.0-1.0}',
    '',
    'You are a repository search agent. Your job is to answer the task using concrete repository evidence from tool calls.',
    '',
    'Core behavior:',
    '- Prioritize factual, file-grounded conclusions over speculation.',
    '- Treat "no evidence of X found" as a valid outcome when supported by comprehensive search.',
    '- Never fabricate file paths, line numbers, commands, or findings.',
    '',
    'Evidence rules:',
    '- Every substantive claim must be backed by concrete evidence from executed commands.',
    '- Prefer production source evidence over tests, coverage, generated artifacts, or docs unless explicitly requested.',
    '- If evidence is weak, partial, or ambiguous, explicitly say so.',
    '',
    'Search discipline:',
    '- Use iterative searches and targeted file inspection.',
    '- Avoid repeating failed commands.',
    '- Adjust strategy when searches are too broad, noisy, or low-signal.',
    '- Keep commands efficient and focused on the task objective.',
    '',
    'Final response requirements:',
    '- Always produce a final answer, even if incomplete.',
    '- If evidence is sufficient: give a direct verdict and provide file:line evidence with brief justification.',
    '- If evidence is insufficient: explicitly state insufficiency, summarize searches and findings, identify blockers/gaps, and provide a best-effort conclusion with clear uncertainty.',
    '',
    'Output style:',
    '- Concise, structured, and directly tied to the question.',
    '- Include concrete file:line references when available.',
    '- Distinguish clearly between confirmed evidence, reasonable inference, and unknown/not proven.',
    '',
    'Return exactly one JSON action per turn.',
    'Allowed tool action: {"action":"tool","tool_name":"run_repo_cmd","args":{"command":"..."}}',
    'Finish action format: {"action":"finish","output":"...","confidence":0.0-1.0}',
    `Turn ${options.turn} of ${options.maxTurns}.`,
    '',
    'Rules:',
    '- Use only read-only commands.',
    '- This is a Windows machine so stick to PowerShell-valid commands only.',
    '- Prefer rg for search.',
    '- One command per turn.',
    '- Finish when you have enough evidence.',
    '- Minimum depth rule: do at least 5 tool-call turns before finishing.',
    '- If you try to finish before 5 tool-call turns, you will be told: "that was a shallow search, there might be more hidden references/usages. Dive deeper".',
    '',
    'Command selection guide (Windows/PowerShell):',
    '- For broad multi-file keyword/code search: use `rg -n "<pattern>" <path>`',
    '- For filename discovery across repo: use `rg --files`',
    '- For listing directories/files in a path: use `Get-ChildItem <path>` (or `ls`)',
    '- For reading a specific file section: use `Get-Content <file>` (optionally with `| Select-Object -First N` or `-Skip N -First M`)',
    '- For quick repo state context: use `git status --short`',
    '- For inspecting commit/content history: use `git log` or `git show`',
    '- For current directory context: use `pwd`',
    '',
    'JSON action examples:',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"buildPlannerToolDefinitions\\" src\\\\summary.ts"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"getConfiguredLlamaNumCtx\\" src tests"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg --files"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-ChildItem src -Recurse -Filter *.ts"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 80"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"git status --short"}}',
    '{"action":"finish","output":"Found definition in src/config.ts and usage sites in src/summary.ts.","confidence":0.93}',
    '',
    'Do not use Unix-only commands/flags:',
    '- `ls -la`',
    '- `head`, `find`, `xargs`, `grep`',
    '- `rg --type-all`',
    '',
    'What not to do (examples):',
    '- Do not start with coverage/test-only noise first (for example `rg -n "buildFullGraph" coverage`).',
    '- Do not run the same failed command again without changing it.',
    '- Do not claim mutations from read-only operations like `.map`, `.filter`, or `.length`.',
    '- Do not answer without concrete `file:line` evidence.',
    '- Do not search outside the repo root path.',
    '- Invalid tool usage example: `{"action":"tool","tool_name":"read_lines","args":{"path":"src/app.ts"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"cmd":"rg -n \\"x\\" src"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"run_repo_cmd","args":{}}`.',
    '- Invalid mixed-type example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" --type ts --type tsx src"}}`.',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" src; del file.txt"}}`.',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\x.ts | Out-File out.txt"}}`.',
    '',
    `Task: ${options.question}`,
    `Tool-call turns completed so far: ${options.toolCallTurns}`,
    `Tool-call budget remaining: ${Math.max(Number(options.maxTurns || 0) - Number(options.toolCallTurns || 0), 0)}`,
  ];
  if (Number.isFinite(options.zeroOutputRemaining) && options.zeroOutputRemaining >= 0) {
    if (options.zeroOutputRemaining > 0) {
      sections.push(
        `Zero-output warning: ${options.zeroOutputRemaining} more zero-output command(s) and you will be forced to answer.`
      );
    } else {
      sections.push(
        `Zero-output limit reached: you must return a finish action now (forced finish attempts remaining: ${options.forcedFinishAttemptsRemaining || 0}).`
      );
    }
  }
  if ((options.forcedFinishAttemptsRemaining || 0) > 0) {
    sections.push('Forced finish mode: return {"action":"finish",...} now. Tool calls are blocked.');
  }

  if (options.history.length > 0) {
    sections.push('', 'Previous tool calls/results:');
    for (const item of options.history) {
      sections.push(`Command: ${item.command}`);
      sections.push(`Result: ${item.resultText}`);
    }
  }

  return sections.join('\n');
}

function evaluateTaskSignals(task, evidenceText) {
  const missingSignals = [];
  for (const signal of task.signals) {
    const regex = new RegExp(signal, 'iu');
    if (!regex.test(evidenceText)) {
      missingSignals.push(signal);
    }
  }
  return {
    passed: missingSignals.length === 0,
    missingSignals,
  };
}

function estimateTokenCount(config, text) {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(String(text || '').length / charsPerToken));
}

function resolveRepoSearchRequestMaxTokens(options = {}) {
  const explicitMaxTokens = Number(options.requestMaxTokens);
  if (Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    return Math.floor(explicitMaxTokens);
  }
  const configuredMaxTokens = Number(getConfiguredLlamaSetting(options.config || {}, 'MaxTokens'));
  if (Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0) {
    return Math.floor(Math.min(configuredMaxTokens, DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS));
  }
  return DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS;
}

async function countTokensWithFallback(config, text) {
  try {
    const tokenCount = await countLlamaCppTokens(config, text);
    if (Number.isFinite(tokenCount) && Number(tokenCount) > 0) {
      return Number(tokenCount);
    }
  } catch {
    // Fall back to estimate below.
  }
  return estimateTokenCount(config, text);
}

async function runTaskLoop(task, options) {
  const maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
  const maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
  const history = [];
  const commands = [];
  let finalOutput = '';
  let invalidResponses = 0;
  let commandFailures = 0;
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
  let thinkingEnabled = false;
  const attemptedCommands = new Set();
  const minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
  const totalContextTokens = Math.max(
    1,
    Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))
  );
  const thinkingBufferTokens = Math.max(
    Math.ceil(totalContextTokens * THINKING_BUFFER_RATIO),
    THINKING_BUFFER_MIN_TOKENS
  );
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const perToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * PER_TOOL_RESULT_RATIO));
  const requestMaxTokens = resolveRepoSearchRequestMaxTokens(options);
  const rejectNonThinkingFinish = options.enforceThinkingFinish === true;
  let zeroOutputStreak = 0;
  let forcedFinishAttemptsRemaining = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turnsUsed = turn;
    const inForcedFinishMode = forcedFinishAttemptsRemaining > 0;
    const plannerThinkingEnabled = inForcedFinishMode ? true : (thinkingEnabled || (((commands.length + 1) % 5) === 0));
    const prompt = buildTaskPrompt({
      question: task.question,
      turn,
      maxTurns,
      history,
      toolCallTurns: commands.length,
      zeroOutputRemaining: Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - zeroOutputStreak, 0),
      forcedFinishAttemptsRemaining,
    });
    options.logger?.write({
      kind: 'turn_model_request',
      taskId: task.id,
      turn,
      thinkingEnabled: plannerThinkingEnabled,
    });
    options.logger?.write({
      kind: 'turn_prompt',
      taskId: task.id,
      turn,
      prompt,
    });

    const response = await requestPlannerAction({
      baseUrl: options.baseUrl,
      model: options.model,
      prompt,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      mockResponses: options.mockResponses,
      mockResponseIndex,
      thinkingEnabled: plannerThinkingEnabled,
      requestMaxTokens,
    });
    if (typeof response.nextMockResponseIndex === 'number') {
      mockResponseIndex = response.nextMockResponseIndex;
    }
    options.logger?.write({
      kind: 'turn_model_response',
      taskId: task.id,
      turn,
      text: response.text,
      thinkingText: response.thinkingText || '',
      mockExhausted: Boolean(response.mockExhausted),
    });
    if (options.onProgress && response.thinkingText) {
      options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: response.thinkingText });
    }
    if (response.mockExhausted) {
      reason = 'mock_responses_exhausted';
      break;
    }

    let action;
    try {
      action = parsePlannerAction(response.text);
      options.logger?.write({
        kind: 'turn_action_parsed',
        taskId: task.id,
        turn,
        action,
      });
    } catch (error) {
      invalidResponses += 1;
      options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: task.id,
        turn,
        invalidResponses,
        error: error instanceof Error ? error.message : String(error),
      });
      if (invalidResponses >= maxInvalidResponses) {
        reason = 'invalid_response_limit';
        break;
      }
      history.push({
        command: '[invalid action]',
        resultText: `Invalid action: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (action.action === 'finish') {
      if (commands.length < minToolCallsBeforeFinish) {
        const warning = 'that was a shallow search, there might be more hidden references/usages. Dive deeper';
        history.push({
          command: '[finish rejected]',
          resultText: warning,
        });
        options.logger?.write({
          kind: 'turn_finish_rejected',
          taskId: task.id,
          turn,
          toolCallTurns: commands.length,
          minToolCallsBeforeFinish,
          warning,
        });
        continue;
      }
      if (rejectNonThinkingFinish && !plannerThinkingEnabled) {
        history.push({
          command: '[finish rejected]',
          resultText: 'Rejected finish from non-thinking turn. Re-run finish with thinking enabled.',
        });
        options.logger?.write({
          kind: 'turn_finish_rejected_non_thinking',
          taskId: task.id,
          turn,
          warning: 'Rejected finish from non-thinking turn. Re-run finish with thinking enabled.',
        });
        if (!thinkingEnabled) {
          thinkingEnabled = true;
          options.logger?.write({
            kind: 'turn_thinking_mode_switched',
            taskId: task.id,
            turn,
            fromThinkingEnabled: false,
            toThinkingEnabled: true,
            reason: 'finish_non_thinking_rejected',
          });
        }
        continue;
      }
      options.logger?.write({
        kind: 'turn_finish_validation_skipped',
        taskId: task.id,
        turn,
        reason: 'planner_already_thinking',
      });
      finalOutput = action.output;
      reason = 'finish';
      break;
    }

    const command = action.args.command;
    if (attemptedCommands.has(command)) {
      const duplicateReason = 'Exact command was already executed';
      commandFailures += 1;
      options.logger?.write({
        kind: 'turn_command_duplicate_blocked',
        taskId: task.id,
        turn,
        command,
        reason: duplicateReason,
      });
      commands.push({
        command,
        safe: false,
        reason: duplicateReason,
        exitCode: null,
        output: `Rejected command: ${duplicateReason}`,
      });
      history.push({ command, resultText: `Rejected command: ${duplicateReason}` });
      continue;
    }
    attemptedCommands.add(command);
    if (inForcedFinishMode) {
      forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
      const forcedReason = `Forced finish mode active. Return a finish action now. Attempts remaining: ${forcedFinishAttemptsRemaining}.`;
      commandFailures += 1;
      options.logger?.write({
        kind: 'turn_forced_finish_tool_blocked',
        taskId: task.id,
        turn,
        command,
        attemptsRemaining: forcedFinishAttemptsRemaining,
      });
      commands.push({
        command,
        safe: false,
        reason: forcedReason,
        exitCode: null,
        output: `Rejected command: ${forcedReason}`,
      });
      history.push({ command, resultText: `Rejected command: ${forcedReason}` });
      if (forcedFinishAttemptsRemaining === 0) {
        reason = 'forced_finish_attempt_limit';
        break;
      }
      continue;
    }
    const normalized = normalizePlannerCommand(command);
    if (normalized.rejected) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      options.logger?.write({
        kind: 'turn_command_safety',
        taskId: task.id,
        turn,
        command,
        safe: false,
        reason: normalized.rejectedReason,
      });
      commands.push({
        command,
        safe: false,
        reason: normalized.rejectedReason,
        exitCode: null,
        output: rejection,
      });
      history.push({ command, resultText: rejection });
      continue;
    }
    const commandToRun = normalized.command;
    const safety = evaluateCommandSafety(commandToRun, options.repoRoot);
    options.logger?.write({
      kind: 'turn_command_safety',
      taskId: task.id,
      turn,
      command: commandToRun,
      safe: safety.safe,
      reason: safety.reason,
    });
    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({
        command: commandToRun,
        safe: false,
        reason: safety.reason,
        exitCode: null,
        output: rejection,
      });
      history.push({ command: commandToRun, resultText: rejection });
      continue;
    }

    if (options.onProgress) {
      options.onProgress({ kind: 'tool_start', turn, maxTurns, command: commandToRun });
    }
    const executed = await executeRepoCommand(commandToRun, options.repoRoot, options.mockCommandResults || null);
    const baseOutput = `${String(executed.output || '')}`.trim();
    if (options.onProgress) {
      const snippet = baseOutput.length > 200 ? baseOutput.slice(0, 200) + '...' : baseOutput;
      options.onProgress({ kind: 'tool_result', turn, maxTurns, command: commandToRun, exitCode: executed.exitCode, outputSnippet: snippet });
    }
    const outputWithRewriteNote = normalized.rewritten && normalized.note
      ? `${normalized.note}\n${baseOutput}`.trim()
      : baseOutput;
    if (Number(executed.exitCode) !== 0) {
      commandFailures += 1;
    }
    if (outputWithRewriteNote.length === 0) {
      zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - zeroOutputStreak, 0);
      const warningText = remainingBeforeForce > 0
        ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
        : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`;
      history.push({
        command: '[zero-output-warning]',
        resultText: warningText,
      });
      options.logger?.write({
        kind: 'turn_zero_output_countdown',
        taskId: task.id,
        turn,
        zeroOutputStreak,
        remainingBeforeForce,
      });
      if (remainingBeforeForce === 0 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started',
          taskId: task.id,
          turn,
          attemptsRemaining: forcedFinishAttemptsRemaining,
        });
      }
    } else {
      zeroOutputStreak = 0;
    }
    let resultText = `exit_code=${executed.exitCode}\n${outputWithRewriteNote}`.trim();
    const useEstimatedTokensOnly = Array.isArray(options.mockResponses);
    const promptTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, prompt)
      : await countTokensWithFallback(options.config, prompt);
    const resultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, resultText)
      : await countTokensWithFallback(options.config, resultText);
    const remainingTokenAllowance = Math.max(usablePromptTokens - promptTokenCount, 0);
    if (resultTokenCount > perToolCapTokens || resultTokenCount > remainingTokenAllowance) {
      resultText = `Error: requested output would consume ${resultTokenCount} tokens, remaining token allowance: ${remainingTokenAllowance}, per tool call allowance: ${perToolCapTokens}`;
    }
    options.logger?.write({
      kind: 'turn_command_result',
      taskId: task.id,
      turn,
      command: commandToRun,
      exitCode: executed.exitCode,
      output: outputWithRewriteNote,
      promptTokenCount,
      resultTokenCount,
      perToolCapTokens,
      remainingTokenAllowance,
      insertedResultText: resultText,
    });
    commands.push({
      command: commandToRun,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: outputWithRewriteNote,
    });
    history.push({ command: commandToRun, resultText });
  }

  if (!String(finalOutput || '').trim()) {
    let usedFallback = false;
    const synthesisPrompt = buildTerminalSynthesisPrompt({
      question: task.question,
      reason,
      history,
    });
    options.logger?.write({
      kind: 'task_terminal_synthesis_requested',
      taskId: task.id,
      reason,
    });
    try {
      const synthesisResponse = await requestTerminalSynthesis({
        baseUrl: options.baseUrl,
        model: options.model,
        prompt: synthesisPrompt,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        mockResponses: options.mockResponses,
        mockResponseIndex,
        requestMaxTokens,
      });
      if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
        mockResponseIndex = synthesisResponse.nextMockResponseIndex;
      }
      options.logger?.write({
        kind: 'task_terminal_synthesis_raw_response',
        taskId: task.id,
        text: synthesisResponse.text,
        thinkingText: synthesisResponse.thinkingText || '',
        mockExhausted: Boolean(synthesisResponse.mockExhausted),
      });
      if (!synthesisResponse.mockExhausted && String(synthesisResponse.text || '').trim()) {
        finalOutput = String(synthesisResponse.text).trim();
      } else {
        usedFallback = true;
        finalOutput = buildTerminalSynthesisFallback({ reason, commands });
      }
    } catch (error) {
      options.logger?.write({
        kind: 'task_terminal_synthesis_error',
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      usedFallback = true;
      finalOutput = buildTerminalSynthesisFallback({ reason, commands });
    }
    options.logger?.write({
      kind: 'task_terminal_synthesis_result',
      taskId: task.id,
      usedFallback,
      finalOutput,
    });
  }

  const evidenceParts = [finalOutput, ...commands.map((item) => item.output)];
  const signalCheck = evaluateTaskSignals(task, evidenceParts.join('\n'));
  const passed = signalCheck.passed && commandFailures === 0;
  options.logger?.write({
    kind: 'task_done',
    taskId: task.id,
    reason,
    turnsUsed,
    safetyRejects,
    invalidResponses,
    commandFailures,
    passed,
    missingSignals: signalCheck.missingSignals,
  });

  return {
    id: task.id,
    question: task.question,
    reason,
    turnsUsed,
    safetyRejects,
    invalidResponses,
    commandFailures,
    commands,
    finalOutput,
    passed,
    missingSignals: signalCheck.missingSignals,
  };
}

function buildScorecard(options) {
  const totals = {
    tasks: options.tasks.length,
    passed: options.tasks.filter((task) => task.passed).length,
    failed: options.tasks.filter((task) => !task.passed).length,
    commandsExecuted: options.tasks.reduce((sum, task) => sum + task.commands.length, 0),
    safetyRejects: options.tasks.reduce((sum, task) => sum + task.safetyRejects, 0),
    invalidResponses: options.tasks.reduce((sum, task) => sum + task.invalidResponses, 0),
    commandFailures: options.tasks.reduce((sum, task) => sum + Number(task.commandFailures || 0), 0),
  };

  const failureReasons = [];
  for (const task of options.tasks) {
    if (task.passed) {
      continue;
    }
    if (Array.isArray(task.missingSignals) && task.missingSignals.length > 0) {
      failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    }
    if (Number(task.commandFailures || 0) > 0) {
      failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    }
    if ((task.missingSignals?.length || 0) === 0 && Number(task.commandFailures || 0) === 0) {
      failureReasons.push(`${task.id}: task failed`);
    }
  }

  return {
    runId: options.runId,
    model: options.model,
    tasks: options.tasks,
    totals,
    verdict: totals.failed === 0 ? 'pass' : 'fail',
    failureReasons,
  };
}

function assertConfiguredModelPresent(model, availableModels) {
  if (!Array.isArray(availableModels) || !availableModels.includes(model)) {
    throw new Error(
      `Configured model not found: ${model}. Available models: ${Array.isArray(availableModels) ? availableModels.join(', ') : 'none'}`
    );
  }
}

async function runMockRepoSearch(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const config = options.config || await loadConfig({ ensure: true });
  const model = options.model || getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);
  options.logger?.write({
    kind: 'run_start',
    repoRoot,
    requestedModel: options.model || null,
    configuredModel: model,
    baseUrl,
  });
  const availableModels = options.availableModels || await listLlamaCppModels(config);
  options.logger?.write({
    kind: 'model_inventory',
    configuredModel: model,
    availableModels,
  });

  const tasksToRun = options.taskPrompt
    ? [{
      id: 'repo-search',
      question: String(options.taskPrompt),
      signals: [],
    }]
    : TASK_PACK;
  const tasks = [];
  const requestMaxTokens = resolveRepoSearchRequestMaxTokens({
    config,
    requestMaxTokens: options.requestMaxTokens,
  });
  for (const task of tasksToRun) {
    const result = await runTaskLoop(task, {
      repoRoot,
      model,
      baseUrl,
      config,
      totalContextTokens: getConfiguredLlamaNumCtx(config),
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxTurns: options.maxTurns || DEFAULT_MAX_TURNS,
      maxInvalidResponses: options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES,
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,
      requestMaxTokens,
      enforceThinkingFinish: true,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      logger: options.logger || null,
      onProgress: options.onProgress || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({
    runId: randomUUID(),
    model,
    tasks,
  });
  options.logger?.write({
    kind: 'run_done',
    scorecard,
  });
  return scorecard;
}

function parseCliArgs(argv) {
  const parsed = {
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    logFile: path.join(os.tmpdir(), `siftkit-mock-repo-search-${Date.now()}.jsonl`),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--max-turns') {
      parsed.maxTurns = Number(argv[++i]);
    } else if (token === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[++i]);
    } else if (token === '--repo-root') {
      parsed.repoRoot = argv[++i];
    } else if (token === '--model') {
      parsed.model = argv[++i];
    } else if (token === '--log-file') {
      parsed.logFile = argv[++i];
    }
  }
  return parsed;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const logger = createJsonlLogger(args.logFile);
  const scorecard = await runMockRepoSearch({
    repoRoot: args.repoRoot,
    maxTurns: args.maxTurns,
    timeoutMs: args.timeoutMs,
    model: args.model,
    logger,
  });
  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  process.stdout.write(
    `Summary: verdict=${scorecard.verdict} passed=${scorecard.totals.passed}/${scorecard.totals.tasks} `
    + `commands=${scorecard.totals.commandsExecuted} safetyRejects=${scorecard.totals.safetyRejects}\n`
  );
  process.stdout.write(`Transcript: ${logger.path}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  TASK_PACK,
  parsePlannerAction,
  evaluateCommandSafety,
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runMockRepoSearch,
  resolveRepoSearchRequestMaxTokens,
  estimateTokenCount,
  countTokensWithFallback,
};
