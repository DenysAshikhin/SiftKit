import type { MutableJsonObject, OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolCall } from './types.js';

const QWEN_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gu;
const QWEN_FUNCTION_PATTERN = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/u;
const QWEN_PARAMETER_PATTERN = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gu;

type RawFunctionCall = {
  name?: OptionalJsonValue;
  arguments?: OptionalJsonValue;
};

type RawToolCall = {
  id?: OptionalJsonValue;
  type?: OptionalJsonValue;
  function?: RawFunctionCall;
};

type RawChoice = {
  message?: {
    tool_calls?: RawToolCall[] | null;
    function_call?: RawFunctionCall;
  };
  tool_calls?: RawToolCall[] | null;
};

export type ReplayToolCallInput = {
  id: string;
  command: string;
};

type ParsedReplayCommand = {
  toolName: string;
  args: MutableJsonObject;
};

/**
 * Persisted tool commands replay as the tool call that produced them. Native tools persist the
 * synthetic `<tool> key=<json>` form built by buildRepoToolRequestedCommand; `git` persists its raw
 * command line. Kept in step with EXPOSED_REPO_TOOL_NAMES in repo-search/planner-protocol.ts —
 * importing it here would close an import cycle.
 */
const REPLAY_NATIVE_TOOL_NAMES = new Set<string>(['read', 'grep', 'find', 'ls', 'web_search', 'web_fetch']);
const REPLAY_COMMAND_TOOL_NAME = 'git';
const REPLAY_ARGUMENT_PATTERN = /([A-Za-z][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|true|false|-?\d+(?:\.\d+)?)/gu;

export class LlamaCppToolCallParser {
  private readonly allowedToolNames: Set<string>;

  constructor(allowedToolNames: readonly string[]) {
    this.allowedToolNames = new Set(allowedToolNames);
  }

  parseFromChoice(choice: RawChoice): LlamaCppToolCall[] {
    const calls: LlamaCppToolCall[] = [];
    for (const raw of choice.message?.tool_calls || []) {
      const parsed = this.parseToolCall(raw);
      if (parsed) calls.push(parsed);
    }
    for (const raw of choice.tool_calls || []) {
      const parsed = this.parseToolCall(raw);
      if (parsed) calls.push(parsed);
    }
    const legacy = this.parseLegacyFunctionCall(choice.message?.function_call);
    if (legacy) calls.push(legacy);
    return calls;
  }

  parseFromText(text: string): LlamaCppToolCall[] {
    const calls: LlamaCppToolCall[] = [];
    for (const blockMatch of text.matchAll(QWEN_TOOL_CALL_PATTERN)) {
      const functionMatch = QWEN_FUNCTION_PATTERN.exec(blockMatch[1] || '');
      const name = functionMatch?.[1]?.trim() || '';
      if (!this.allowedToolNames.has(name)) continue;
      const parameters: Record<string, OptionalJsonValue> = {};
      for (const parameterMatch of (functionMatch?.[2] || '').matchAll(QWEN_PARAMETER_PATTERN)) {
        const parameterName = parameterMatch[1]?.trim() || '';
        if (!parameterName) continue;
        parameters[parameterName] = parseQwenParameterValue(decodeXmlText(parameterMatch[2] || ''));
      }
      calls.push({
        id: `call_${name}_${calls.length}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(parameters) },
      });
    }
    return calls;
  }

  parseToolCall(raw: RawToolCall): LlamaCppToolCall | null {
    const name = typeof raw.function?.name === 'string' ? raw.function.name.trim() : '';
    if (!this.allowedToolNames.has(name)) return null;
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `call_${name}`,
      type: 'function',
      function: {
        name,
        arguments: typeof raw.function?.arguments === 'string' ? raw.function.arguments : '{}',
      },
    };
  }

  private parseLegacyFunctionCall(raw: RawFunctionCall | undefined): LlamaCppToolCall | null {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!this.allowedToolNames.has(name)) return null;
    return {
      id: `call_${name}`,
      type: 'function',
      function: {
        name,
        arguments: typeof raw?.arguments === 'string' ? raw.arguments : '{}',
      },
    };
  }
}

function parseQwenParameterValue(value: string): OptionalJsonValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

export function buildReplayToolCall(input: ReplayToolCallInput): LlamaCppToolCall {
  const parsed = parseReplayCommand(input.command);
  if (!parsed) {
    throw new Error(`Cannot replay unknown persisted tool command: ${input.command.trim()}`);
  }
  return {
    id: input.id,
    type: 'function',
    function: {
      name: parsed.toolName,
      arguments: JSON.stringify(parsed.args),
    },
  };
}

function parseReplayCommand(command: string): ParsedReplayCommand | null {
  const text = command.trim();
  const toolName = getFirstCommandToken(text);
  if (toolName === REPLAY_COMMAND_TOOL_NAME) {
    return { toolName, args: { command: text } };
  }
  if (!REPLAY_NATIVE_TOOL_NAMES.has(toolName)) {
    return null;
  }
  const args = parseNativeReplayArguments(text.slice(toolName.length));
  return args ? { toolName, args } : null;
}

function parseNativeReplayArguments(argumentText: string): MutableJsonObject | null {
  const args: MutableJsonObject = {};
  let matched = false;
  for (const match of argumentText.matchAll(REPLAY_ARGUMENT_PATTERN)) {
    try {
      args[match[1]] = JSON.parse(match[2]);
    } catch {
      return null;
    }
    matched = true;
  }
  return matched ? args : null;
}

function getFirstCommandToken(command: string): string {
  const match = /^\s*(\S+)/u.exec(command);
  return match ? match[1].toLowerCase() : '';
}
