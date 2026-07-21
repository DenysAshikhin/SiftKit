import path from 'node:path';

import { z } from '../../src/lib/zod.js';
import { UNSUPPORTED_INPUT_MESSAGE } from '../../src/summary/measure.js';
import { getDefaultOperationModeAllowedTools, normalizePresets } from '../../src/presets.js';
import { normalizeModelRuntimePresetArray } from '../../src/config/normalization.js';
import {
  JsonValueSchema,
  JsonObjectSchema,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
} from '../../src/lib/json-types.js';
import type { Exl3EngineConfig, InferenceConfig, SiftConfig } from '../../src/config/types.js';

// Chat-request view types are derived from runtime schemas so the JSON catchall
// (tests read arbitrary keys like cache_prompt/id_slot/max_tokens off captured
// requests) is laundered through z.infer rather than written as `unknown`.
const ChatRequestMessageSchema = z.object({
  role: z.string().optional(),
  content: z.union([
    z.string(),
    z.array(z.object({ text: z.string().optional() }).catchall(JsonValueSchema)),
  ]).optional(),
  tool_calls: z.array(z.object({
    function: z.object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    }).optional(),
  }).catchall(JsonValueSchema)).optional(),
  function_call: z.object({
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).optional(),
  tool_call_id: z.string().optional(),
}).catchall(JsonValueSchema);

const ChatRequestSchema = z.object({
  messages: z.array(ChatRequestMessageSchema),
  response_format: z.object({ type: z.string().optional() }).catchall(JsonValueSchema).optional(),
  chat_template_kwargs: JsonObjectSchema.optional(),
}).catchall(JsonValueSchema);

export type ChatRequestMessage = z.infer<typeof ChatRequestMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// Fixture-supplied assistant content: a literal, a per-request responder, or a
// per-request rotation of either. Shared with the stub server in _runtime-helpers.
export type AssistantResponderFn = (promptText: string, parsed: JsonValue, requestIndex: number) => string;
export type AssistantResponder = string | AssistantResponderFn | Array<string | AssistantResponderFn>;

export function deriveServiceUrl(configuredUrl: string, nextPath: string): string {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export function getTestInferenceConfig(): InferenceConfig {
  return {
    Thinking: { Enabled: false, Preserve: false },
  };
}

export function getTestExl3Engine(): Exl3EngineConfig {
  return {
    Managed: true,
    WorkingDirectory: 'C:\\Users\\denys\\Documents\\GitHub\\TabbyAPI',
    PythonPath: 'C:\\envs\\rl310\\Scripts\\python.exe',
    Entrypoint: 'main.py',
    ConfigPath: 'config.yml',
    ModelRoot: 'D:\\personal\\models\\elx3',
    AdminApiKey: '',
    ShutdownTimeoutMs: 30_000,
  };
}

export function getDefaultConfig(): SiftConfig {
  return {
    Version: '0.1.0',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    IncludeAgentsMd: true,
    IncludeRepoFileListing: true,
    ExpandReads: true,
    Inference: getTestInferenceConfig(),
    Runtime: {
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
    },
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: normalizeModelRuntimePresetArray([{
          id: 'default',
          label: 'Default',
          Backend: 'llama',
          Model: 'qwen3.5-9b-instruct-q4_k_m',
          BaseUrl: 'http://127.0.0.1:8080',
          NumCtx: 128000,
        }], {}),
      },
      Engines: { Exl3: getTestExl3Engine() },
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
    OperationModeAllowedTools: getDefaultOperationModeAllowedTools(),
    Presets: normalizePresets([]),
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: false, ApiKey: '' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
  };
}

export function clone<T>(value: T): T {
  return z.custom<T>(() => true).parse(JSON.parse(JSON.stringify(value)));
}

// JSON-serialize-then-validate boundary: views a typed config (or any
// JSON-serializable value) as a plain JsonValue so it can be deep-merged without
// a cast or a Record<string, unknown> index.
export function toJsonValue<T>(value: T): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
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

export function setManagedLlamaBaseUrl(config: SiftConfig, baseUrl: string): void {
  config.Runtime.LlamaCpp.BaseUrl = baseUrl;
  for (const preset of config.Server.ModelPresets.Presets) {
    preset.BaseUrl = baseUrl;
  }
}

export function mergeConfig(baseValue: JsonValue, patchValue: JsonValue): JsonValue {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (isJsonObject(baseValue) && isJsonObject(patchValue)) {
    const merged: MutableJsonObject = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    delete merged.Paths;
    delete merged.Effective;
    const thresholds = merged.Thresholds;
    if (isJsonObject(thresholds)) {
      delete thresholds.MaxInputCharacters;
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
  option: AssistantResponder | undefined,
  promptText: string,
  parsed: JsonValue,
  requestIndex: number,
): string | undefined {
  if (typeof option === 'function') {
    return option(promptText, parsed, requestIndex);
  }

  if (Array.isArray(option)) {
    const item = option[Math.min(requestIndex - 1, option.length - 1)];
    return typeof item === 'function' ? item(promptText, parsed, requestIndex) : item;
  }

  return option;
}
