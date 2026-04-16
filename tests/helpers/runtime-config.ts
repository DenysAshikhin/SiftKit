import path from 'node:path';

import { UNSUPPORTED_INPUT_MESSAGE } from '../../dist/summary/measure.js';

type JsonObject = Record<string, unknown>;

export type ChatRequest = {
  messages?: Array<{
    content?: string | Array<{ text?: string }>;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    function_call?: {
      name?: string;
      arguments?: string;
    };
    tool_call_id?: string;
  }>;
};

export function deriveServiceUrl(configuredUrl: string, nextPath: string): string {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export function getDefaultConfig(): JsonObject {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    Model: 'qwen3.5-9b-instruct-q4_k_m',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      NumCtx: 128000,
      ModelPath: null,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
      MaxTokens: 4096,
      Threads: -1,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getChatRequestText(request: ChatRequest | null | undefined): string {
  if (!request || !Array.isArray(request.messages)) {
    return '';
  }

  return request.messages.map((message) => {
    const parts: string[] = [];
    if (typeof message.content === 'string' && message.content) {
      parts.push(message.content);
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
        .join('');
      if (text) {
        parts.push(text);
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.function?.name) {
          parts.push(String(toolCall.function.name));
        }
        if (toolCall?.function?.arguments) {
          parts.push(String(toolCall.function.arguments));
        }
      }
    }
    if (message.function_call?.name) {
      parts.push(String(message.function_call.name));
    }
    if (message.function_call?.arguments) {
      parts.push(String(message.function_call.arguments));
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      parts.push(message.tool_call_id);
    }
    return parts.join('\n');
  }).join('\n');
}

export function setManagedLlamaBaseUrl(config: JsonObject, baseUrl: string): void {
  const llamaCpp = (config.LlamaCpp ?? {}) as JsonObject;
  const runtime = (config.Runtime ?? {}) as JsonObject;
  const runtimeLlamaCpp = (runtime.LlamaCpp ?? {}) as JsonObject;

  llamaCpp.BaseUrl = baseUrl;
  runtime.Model = config.Model;
  runtimeLlamaCpp.BaseUrl = baseUrl;
  runtime.LlamaCpp = runtimeLlamaCpp;
  config.LlamaCpp = llamaCpp;
  config.Runtime = runtime;
}

export function mergeConfig(baseValue: unknown, patchValue: unknown): unknown {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (
    baseValue
    && patchValue
    && typeof baseValue === 'object'
    && typeof patchValue === 'object'
    && !Array.isArray(baseValue)
    && !Array.isArray(patchValue)
  ) {
    const merged: JsonObject = { ...(baseValue as JsonObject) };
    for (const [key, value] of Object.entries(patchValue as JsonObject)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    delete merged.Paths;
    delete merged.Effective;
    if (merged.Thresholds && typeof merged.Thresholds === 'object') {
      delete (merged.Thresholds as JsonObject).MaxInputCharacters;
    }
    return merged;
  }

  return patchValue;
}

export function extractPromptSection(promptText: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:\\n|$)`, 'u').exec(promptText);
  return match ? match[1].trim() : '';
}

export function buildOversizedTransitionsInput(targetCharacters: number): string {
  const transitions = [
    {
      id: 9001,
      label: 'Lumbridge Castle Staircase',
      type: 'stairs',
      from: { worldX: 3205, worldY: 3214, plane: 0 },
      to: { worldX: 3205, worldY: 3214, plane: 1 },
      bidirectional: true,
      note: 'exact castle match',
    },
    {
      id: 9002,
      label: 'Lumbridge Castle Courtyard Gate',
      type: 'gate',
      from: { worldX: 3212, worldY: 3221, plane: 0 },
      to: { worldX: 3213, worldY: 3221, plane: 0 },
      bidirectional: false,
      note: 'exact castle match',
    },
  ];

  let index = 0;
  while (JSON.stringify(transitions).length < targetCharacters) {
    transitions.push({
      id: 10000 + index,
      label: `Padding Transition ${index}`,
      type: 'padding',
      from: { worldX: 3300 + (index % 50), worldY: 3300 + (index % 50), plane: 0 },
      to: { worldX: 3400 + (index % 50), worldY: 3400 + (index % 50), plane: 0 },
      bidirectional: Boolean(index % 2),
      note: 'P'.repeat(1800),
    });
    index += 1;
  }

  return JSON.stringify(transitions);
}

export function buildOversizedRunnerStateHistoryInput(targetCharacters: number): string {
  const states = [
    {
      timestamp: '2026-03-30T18:39:59Z',
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: null,
      step_id: null,
      state_json: JSON.stringify({
        navigation: { status: 'idle' },
        blocker: null,
      }),
    },
    {
      timestamp: '2026-03-30T18:42:57Z',
      lifecycle_state: 'running',
      bridge_state: 'connected',
      scenario_id: 'poi_verification',
      step_id: 'walk_to_door',
      state_json: JSON.stringify({
        navigation: { status: 'navigating' },
        blocker: { type: 'door', action: 'open' },
      }),
    },
    {
      timestamp: '2026-03-30T18:45:22Z',
      lifecycle_state: 'paused',
      bridge_state: 'connected',
      scenario_id: 'poi_verification',
      step_id: 'walk_to_door',
      state_json: JSON.stringify({
        navigation: { status: 'blocked' },
        blocker: { type: 'door', action: 'open', failureReason: 'Hover confirmation failed for Open on Door.' },
      }),
    },
    {
      timestamp: '2026-03-30T18:50:01Z',
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: null,
      step_id: null,
      state_json: JSON.stringify({
        navigation: { status: 'failed' },
        blocker: null,
      }),
    },
  ];

  let index = 0;
  while (JSON.stringify({ count: states.length, states }).length < targetCharacters) {
    states.push({
      timestamp: `2026-03-30T19:${String(index % 60).padStart(2, '0')}:00Z`,
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: `padding_${index}`,
      step_id: `padding_step_${index}`,
      state_json: JSON.stringify({
        navigation: { status: 'idle' },
        note: 'P'.repeat(1800),
      }),
    });
    index += 1;
  }

  return JSON.stringify({
    count: states.length,
    states,
  });
}

export function getRuntimeRootFromStatusPath(statusPath: string): string {
  const absoluteStatusPath = path.resolve(statusPath);
  const statusDirectory = path.dirname(absoluteStatusPath);
  if (path.basename(statusDirectory).toLowerCase() === 'status') {
    return path.dirname(statusDirectory);
  }

  return statusDirectory;
}

export function getPlannerLogsPath(): string {
  const statusPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  return statusPath && statusPath.trim()
    ? path.join(getRuntimeRootFromStatusPath(statusPath), 'logs')
    : path.join(process.cwd(), '.siftkit', 'logs');
}

export function getFailedLogsPath(): string {
  return path.join(getPlannerLogsPath(), 'failed');
}

export function getRequestLogsPath(): string {
  return path.join(getPlannerLogsPath(), 'requests');
}

export function buildStructuredStubDecision(promptText: string): JsonObject {
  const inputText = extractPromptSection(promptText, 'Input:');

  if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
    return {
      classification: 'unsupported_input',
      raw_review_required: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  if (/Unable to resolve external command/u.test(inputText)) {
    return {
      classification: 'command_failure',
      raw_review_required: true,
      output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
    };
  }

  return {
    classification: 'summary',
    raw_review_required: false,
    output: `summary:${String(promptText).slice(0, 24)}`,
  };
}

export function resolveAssistantContent(
  option: unknown,
  promptText: string,
  parsed: unknown,
  requestIndex: number,
): unknown {
  if (typeof option === 'function') {
    return option(promptText, parsed, requestIndex);
  }

  if (Array.isArray(option)) {
    const item = option[Math.min(requestIndex - 1, option.length - 1)];
    return typeof item === 'function' ? item(promptText, parsed, requestIndex) : item;
  }

  return option;
}
