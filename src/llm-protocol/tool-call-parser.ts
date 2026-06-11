import type { LlamaCppToolCall } from './types.js';

type RawFunctionCall = {
  name?: unknown;
  arguments?: unknown;
};

type RawToolCall = {
  id?: unknown;
  type?: unknown;
  function?: RawFunctionCall;
};

type RawChoice = {
  message?: {
    tool_calls?: RawToolCall[];
    function_call?: RawFunctionCall;
  };
  tool_calls?: RawToolCall[];
};

export type ReplayToolCallInput = {
  id: string;
  command: string;
};

type ParsedReplayCommand = {
  toolName: string;
  argumentName: 'query' | 'url' | 'command';
  value: string;
};

const REPLAY_REPO_COMMAND_TOKENS = new Set<string>([
  'rg',
  'git',
  'get-content',
  'get-childitem',
  'select-string',
  'pwd',
  'ls',
  'select-object',
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
      arguments: JSON.stringify({ [parsed.argumentName]: parsed.value }),
    },
  };
}

function parseReplayCommand(command: string): ParsedReplayCommand | null {
  const text = command.trim();
  const search = parseNamedReplayCommand(text, 'web_search', 'query');
  if (search) return search;
  const fetch = parseNamedReplayCommand(text, 'web_fetch', 'url');
  if (fetch) return fetch;
  const repo = parseRepoReplayCommand(text);
  if (repo) return repo;
  return null;
}

function parseNamedReplayCommand(
  text: string,
  toolName: 'web_search' | 'web_fetch',
  argumentName: 'query' | 'url',
): ParsedReplayCommand | null {
  const assignmentPrefix = `${toolName} ${argumentName}=`;
  if (text.startsWith(assignmentPrefix)) {
    const value = parseQuotedReplayValue(text.slice(assignmentPrefix.length));
    return value ? { toolName, argumentName, value } : null;
  }
  const colonPrefix = `${toolName}:`;
  if (text.startsWith(colonPrefix)) {
    const value = text.slice(colonPrefix.length).trim();
    return value ? { toolName, argumentName, value } : null;
  }
  return null;
}

function parseRepoReplayCommand(text: string): ParsedReplayCommand | null {
  const commandToken = getFirstCommandToken(text);
  if (!REPLAY_REPO_COMMAND_TOKENS.has(commandToken)) return null;
  return {
    toolName: `repo_${commandToken.replace(/[^a-z0-9]+/gu, '_')}`,
    argumentName: 'command',
    value: text,
  };
}

function getFirstCommandToken(command: string): string {
  const match = /^\s*(\S+)/u.exec(command);
  return match ? match[1].toLowerCase() : '';
}

function parseQuotedReplayValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' && parsed.trim() ? parsed : null;
  } catch {
    return trimmed;
  }
}
