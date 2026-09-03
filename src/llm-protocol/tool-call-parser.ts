import type { MutableJsonObject, OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolCall } from './types.js';

const TOOL_CALL_OPEN_TAG = '<tool_call>';
const TOOL_CALL_CLOSE_TAG = '</tool_call>';
const QWEN_TOOL_CALL_PATTERN = new RegExp(`${TOOL_CALL_OPEN_TAG}\\s*([\\s\\S]*?)\\s*${TOOL_CALL_CLOSE_TAG}`, 'gu');
const QWEN_FUNCTION_PATTERN = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/u;
const QWEN_PARAMETER_PATTERN = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gu;
type CodeRegion = { start: number; end: number };
type MarkdownCodeScan = { regions: CodeRegion[]; incompleteStart: number | null };

function scanMarkdownCode(text: string): MarkdownCodeScan {
  const regions: CodeRegion[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('`', index);
    if (start < 0) break;
    if (text.startsWith('```', start)) {
      const close = text.indexOf('```', start + 3);
      if (close < 0) return { regions, incompleteStart: start };
      const end = close + 3;
      regions.push({ start, end });
      index = end;
      continue;
    }
    const close = text.indexOf('`', start + 1);
    const newline = text.indexOf('\n', start + 1);
    if (close < 0 || (newline >= 0 && newline < close)) {
      if (newline < 0) return { regions, incompleteStart: start };
      index = newline + 1;
      continue;
    }
    const end = close + 1;
    regions.push({ start, end });
    index = end;
  }
  return { regions, incompleteStart: null };
}

function isInsideCodeRegion(regions: readonly CodeRegion[], index: number): boolean {
  return regions.some((region) => index >= region.start && index < region.end);
}

function hasBareOpenTag(text: string, regions: readonly CodeRegion[]): boolean {
  return findBareOpenTag(text, regions) >= 0;
}

function findBareOpenTag(text: string, regions: readonly CodeRegion[]): number {
  for (let index = text.indexOf(TOOL_CALL_OPEN_TAG); index !== -1; index = text.indexOf(TOOL_CALL_OPEN_TAG, index + 1)) {
    if (!isInsideCodeRegion(regions, index)) return index;
  }
  return -1;
}

function getTrailingOpenTagPrefixLength(text: string, regions: readonly CodeRegion[]): number {
  const maxLength = Math.min(text.length, TOOL_CALL_OPEN_TAG.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const start = text.length - length;
    if (!isInsideCodeRegion(regions, start) && TOOL_CALL_OPEN_TAG.startsWith(text.slice(start))) {
      return length;
    }
  }
  return 0;
}

export type TextToolCallScan = {
  calls: LlamaCppToolCall[];
  /** True when the opener tag appears outside markdown code — evidence of a textual tool-call attempt. */
  sawBareMarkup: boolean;
};

export type TextToolCallProjection = {
  classification: 'undecided' | 'narration' | 'tool_control';
  narrationText: string;
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
 * INTERACTIVE_REPO_TOOL_NAMES in planner-protocol/repo-search.ts —
 * importing it here would close an import cycle.
 */
const REPLAY_NATIVE_TOOL_NAMES = new Set<string>([
  'read',
  'grep',
  'find',
  'ls',
  'git',
  'web_search',
  'web_fetch',
  'write',
  'edit',
  'run',
]);
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
    const codeRegions = scanMarkdownCode(text).regions;
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

  projectStreamText(text: string): TextToolCallProjection {
    if (!text) return { classification: 'undecided', narrationText: '' };
    const markdown = scanMarkdownCode(text);
    const codeRegions = markdown.regions;
    const bareOpenTagIndex = findBareOpenTag(text, codeRegions);
    if (markdown.incompleteStart !== null
      && (bareOpenTagIndex < 0 || markdown.incompleteStart < bareOpenTagIndex)) {
      const visiblePrefix = text.slice(0, markdown.incompleteStart);
      const prefixLength = getTrailingOpenTagPrefixLength(visiblePrefix, codeRegions);
      return {
        classification: 'undecided',
        narrationText: prefixLength > 0 ? visiblePrefix.slice(0, -prefixLength) : visiblePrefix,
      };
    }
    if (bareOpenTagIndex >= 0) {
      return {
        classification: 'tool_control',
        narrationText: text.slice(0, bareOpenTagIndex),
      };
    }
    const prefixLength = getTrailingOpenTagPrefixLength(text, codeRegions);
    if (prefixLength > 0) {
      return {
        classification: 'undecided',
        narrationText: text.slice(0, -prefixLength),
      };
    }
    return { classification: 'narration', narrationText: text };
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
