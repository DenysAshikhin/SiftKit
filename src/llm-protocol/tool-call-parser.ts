import type { MutableJsonObject, OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolCall } from './types.js';

const TOOL_CALL_OPEN_TAG = '<tool_call>';
const TOOL_CALL_CLOSE_TAG = '</tool_call>';
const QWEN_TOOL_CALL_PATTERN = new RegExp(`${TOOL_CALL_OPEN_TAG}\\s*([\\s\\S]*?)\\s*${TOOL_CALL_CLOSE_TAG}`, 'gu');
const QWEN_FUNCTION_PATTERN = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/u;
const QWEN_PARAMETER_PATTERN = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gu;
/** Fenced blocks first so their backtick pairs cannot be consumed as inline code. */
const MARKDOWN_CODE_REGION_PATTERN = /```[\s\S]*?```|`[^`\n]*`/gu;

type CodeRegion = { start: number; end: number };

function findMarkdownCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  for (const match of text.matchAll(MARKDOWN_CODE_REGION_PATTERN)) {
    if (typeof match.index !== 'number') continue;
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  return regions;
}

function isInsideCodeRegion(regions: readonly CodeRegion[], index: number): boolean {
  return regions.some((region) => index >= region.start && index < region.end);
}

function hasBareOpenTag(text: string, regions: readonly CodeRegion[]): boolean {
  for (let index = text.indexOf(TOOL_CALL_OPEN_TAG); index !== -1; index = text.indexOf(TOOL_CALL_OPEN_TAG, index + 1)) {
    if (!isInsideCodeRegion(regions, index)) return true;
  }
  return false;
}

export type TextToolCallScan = {
  calls: LlamaCppToolCall[];
  /** True when the opener tag appears outside markdown code — evidence of a textual tool-call attempt. */
  sawBareMarkup: boolean;
};

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
 * synthetic `<tool> key=<json>` form built by buildRepoToolRequestedCommand. Kept in step with
 * EXPOSED_REPO_TOOL_NAMES in repo-search/planner-protocol.ts —
 * importing it here would close an import cycle.
 */
const REPLAY_NATIVE_TOOL_NAMES = new Set<string>(['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch']);
const REPLAY_ARGUMENT_PATTERN = /([A-Za-z][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|true|false|-?\d+(?:\.\d+)?)/gu;

export class LlamaCppToolCallParser {
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

  /**
   * Textual (Qwen-dialect) tool calls are emitted bare; markup inside markdown code regions
   * is a quoted example, not an attempt. Regions are honoured by position rather than by
   * stripping so parameter values containing backticks survive intact.
   */
  scanFromText(text: string): TextToolCallScan {
    const codeRegions = findMarkdownCodeRegions(text);
    const calls: LlamaCppToolCall[] = [];
    for (const blockMatch of text.matchAll(QWEN_TOOL_CALL_PATTERN)) {
      if (typeof blockMatch.index !== 'number' || isInsideCodeRegion(codeRegions, blockMatch.index)) continue;
      const functionMatch = QWEN_FUNCTION_PATTERN.exec(blockMatch[1] || '');
      const name = functionMatch?.[1]?.trim() || '';
      if (!name) continue;
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
    return { calls, sawBareMarkup: hasBareOpenTag(text, codeRegions) };
  }

  parseToolCall(raw: RawToolCall): LlamaCppToolCall | null {
    const name = typeof raw.function?.name === 'string' ? raw.function.name.trim() : '';
    if (!name) return null;
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
    if (!name) return null;
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
