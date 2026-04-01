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
  getEffectiveInputCharactersPerContextToken,
} = require('../dist/config.js');
const { listLlamaCppModels, countLlamaCppTokens } = require('../dist/providers/llama-cpp.js');

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_INVALID_RESPONSES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;
const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const PER_TOOL_RESULT_RATIO = 0.10;

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
 *   reason: 'finish' | 'max_turns' | 'invalid_response_limit' | 'mock_responses_exhausted',
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
      max_tokens: 700,
      extra_body: {
        grammar: plannerGrammar(),
        tools: TOOL_DEFINITIONS,
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

function parsePlannerAction(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (error) {
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

function referencesPathOutsideRepo(command, repoRoot) {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  if (!normalizedRepoRoot) {
    return false;
  }
  if (/\.\.[\\/]/u.test(command)) {
    return true;
  }
  if (/\\\\[a-z0-9_.-]+\\/iu.test(command)) {
    return true;
  }
  const absolutePathMatches = command.match(/[a-zA-Z]:\\[^"'`\s|;<>]*/gu) || [];
  for (const match of absolutePathMatches) {
    const normalizedMatch = String(match).replace(/\//gu, '\\').toLowerCase();
    if (!normalizedMatch.startsWith(normalizedRepoRoot)) {
      return true;
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
    `Task: ${options.question}`,
    `Tool-call turns completed so far: ${options.toolCallTurns}`,
  ];

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
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
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

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turnsUsed = turn;
    const prompt = buildTaskPrompt({
      question: task.question,
      turn,
      maxTurns,
      history,
      toolCallTurns: commands.length,
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
      finalOutput = action.output;
      reason = 'finish';
      break;
    }

    const command = action.args.command;
    const safety = evaluateCommandSafety(command, options.repoRoot);
    options.logger?.write({
      kind: 'turn_command_safety',
      taskId: task.id,
      turn,
      command,
      safe: safety.safe,
      reason: safety.reason,
    });
    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({
        command,
        safe: false,
        reason: safety.reason,
        exitCode: null,
        output: rejection,
      });
      history.push({ command, resultText: rejection });
      continue;
    }

    const executed = await executeRepoCommand(command, options.repoRoot, options.mockCommandResults || null);
    let resultText = `exit_code=${executed.exitCode}\n${executed.output}`.trim();
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
      command,
      exitCode: executed.exitCode,
      output: executed.output,
      promptTokenCount,
      resultTokenCount,
      perToolCapTokens,
      remainingTokenAllowance,
      insertedResultText: resultText,
    });
    commands.push({
      command,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: executed.output,
    });
    history.push({ command, resultText });
  }

  const evidenceParts = [finalOutput, ...commands.map((item) => item.output)];
  const signalCheck = evaluateTaskSignals(task, evidenceParts.join('\n'));
  options.logger?.write({
    kind: 'task_done',
    taskId: task.id,
    reason,
    turnsUsed,
    safetyRejects,
    invalidResponses,
    passed: signalCheck.passed,
    missingSignals: signalCheck.missingSignals,
  });

  return {
    id: task.id,
    question: task.question,
    reason,
    turnsUsed,
    safetyRejects,
    invalidResponses,
    commands,
    finalOutput,
    passed: signalCheck.passed,
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
  };

  const failureReasons = options.tasks
    .filter((task) => !task.passed)
    .map((task) => `${task.id}: missing signals [${task.missingSignals.join(', ')}]`);

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
      logger: options.logger || null,
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
  estimateTokenCount,
  countTokensWithFallback,
};
