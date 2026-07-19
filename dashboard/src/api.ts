import { z } from 'zod';
import {
  RunsResponseSchema, RunDetailResponseSchema, RunLogDeletePreviewResponseSchema, RunLogDeleteResponseSchema,
  MetricsResponseSchema, WebSearchQuotaResponseSchema, IdleSummaryResponseSchema, DashboardHealthSchema,
  SiftConfigSchema, RestartBackendResponseSchema,
  DashboardBenchmarkQuestionPresetsResponseSchema, DashboardBenchmarkQuestionPresetSchema,
  DashboardBenchmarkSessionsResponseSchema, DashboardBenchmarkSessionDetailSchema, DashboardBenchmarkAttemptSchema,
  ManagedFilePickerResponseSchema, LlamaCppConnectionTestResponseSchema, ChatSessionResponseSchema,
  ChatSessionsResponseSchema, RepoSearchAutoAppendPreviewSchema,
  type DashboardConfig,
  type DashboardHealth,
  type ChatSessionResponse,
  type ChatSessionsResponse,
  type IdleSummaryResponse,
  type MetricsResponse,
  type ManagedFilePickerResponse,
  type ManagedFilePickerTarget,
  type LlamaCppConnectionTestResponse,
  type RestartBackendResponse,
  type RunLogDeleteCriteria,
  type RunLogDeletePreviewResponse,
  type RunLogDeleteResponse,
  type RunDetailResponse,
  type RunsResponse,
  type DashboardBenchmarkAttempt,
  type DashboardBenchmarkGradeRequest,
  type DashboardBenchmarkQuestionPreset,
  type DashboardBenchmarkQuestionPresetsResponse,
  type DashboardBenchmarkSessionDetail,
  type DashboardBenchmarkSessionsResponse,
  type DashboardBenchmarkStartRequest,
  type RepoSearchAutoAppendPreview,
  type WebSearchQuotaResponse,
  InferenceRuntimeStatusSchema,
  type InferenceRuntimeStatus,
} from '@siftkit/contracts';
import { ChatStreamReader, type ChatStreamToolEvent } from './lib/chat-stream-parser.js';
import type { JsonValue, JsonSerializable } from '../../src/lib/json-types.js';

export async function parseJsonResponse<S extends z.ZodTypeAny>(response: Response, schema: S): Promise<z.infer<S>> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return schema.parse(await response.json());
}

async function fetchJson<S extends z.ZodTypeAny>(input: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  return parseJsonResponse(await fetch(input, init), schema);
}

export function getRuns(
  search: string,
  kind: string,
  status: string,
  options?: { initial?: boolean; limitPerGroup?: number },
): Promise<RunsResponse> {
  const query = new URLSearchParams();
  if (search.trim()) {
    query.set('search', search.trim());
  }
  if (kind.trim()) {
    query.set('kind', kind.trim());
  }
  if (status.trim()) {
    query.set('status', status.trim());
  }
  if (options?.initial) {
    query.set('initial', '1');
  }
  if (Number.isFinite(Number(options?.limitPerGroup)) && Number(options?.limitPerGroup) > 0) {
    query.set('limitPerGroup', String(Math.trunc(Number(options?.limitPerGroup))));
  }
  const suffix = query.toString();
  return fetchJson(`/dashboard/runs${suffix ? `?${suffix}` : ''}`, RunsResponseSchema);
}

export function getRunDetail(id: string): Promise<RunDetailResponse> {
  return fetchJson(`/dashboard/runs/${encodeURIComponent(id)}`, RunDetailResponseSchema);
}

export function previewRunLogDelete(criteria: RunLogDeleteCriteria): Promise<RunLogDeletePreviewResponse> {
  return fetchJson('/dashboard/admin/run-logs/preview', RunLogDeletePreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
}

export function deleteRunLogs(criteria: RunLogDeleteCriteria): Promise<RunLogDeleteResponse> {
  return fetchJson('/dashboard/admin/run-logs', RunLogDeleteResponseSchema, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
}

export function getMetrics(): Promise<MetricsResponse> {
  return fetchJson('/dashboard/metrics/timeseries', MetricsResponseSchema);
}

export function getWebSearchQuota(): Promise<WebSearchQuotaResponse> {
  return fetchJson('/dashboard/web-search-quota', WebSearchQuotaResponseSchema);
}

export function getIdleSummary(limit = 30): Promise<IdleSummaryResponse> {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  return fetchJson(`/dashboard/metrics/idle-summary?${query.toString()}`, IdleSummaryResponseSchema);
}

export function getDashboardConfig(): Promise<DashboardConfig> {
  return fetchJson('/config?skip_ready=1', SiftConfigSchema).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/Request failed \(404\)/u.test(message)) {
      return fetchJson('/config', SiftConfigSchema);
    }
    throw error;
  });
}

export function updateDashboardConfig(config: DashboardConfig): Promise<DashboardConfig> {
  return fetchJson('/config', SiftConfigSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function restartBackend(): Promise<RestartBackendResponse> {
  const response = await fetch('/status/restart', {
    method: 'POST',
  });
  const text = await response.text();
  let raw: JsonValue;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  if (!response.ok && (!raw || typeof raw !== 'object')) {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return RestartBackendResponseSchema.parse(raw);
}

export function getDashboardHealth(): Promise<DashboardHealth> {
  return fetchJson('/health', DashboardHealthSchema);
}

export function getInferenceRuntimeStatus(): Promise<InferenceRuntimeStatus> {
  return fetchJson('/runtime/inference', InferenceRuntimeStatusSchema);
}

export function getBenchmarkQuestionPresets(): Promise<DashboardBenchmarkQuestionPresetsResponse> {
  return fetchJson('/dashboard/benchmark/question-presets', DashboardBenchmarkQuestionPresetsResponseSchema);
}

export function createBenchmarkQuestionPreset(payload: {
  title: string;
  taskKind: 'repo-search' | 'summary';
  prompt: string;
  enabled: boolean;
}): Promise<{ preset: DashboardBenchmarkQuestionPreset }> {
  return fetchJson('/dashboard/benchmark/question-presets', z.object({ preset: DashboardBenchmarkQuestionPresetSchema }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateBenchmarkQuestionPreset(
  id: string,
  payload: Partial<Pick<DashboardBenchmarkQuestionPreset, 'title' | 'taskKind' | 'prompt' | 'enabled'>>,
): Promise<{ preset: DashboardBenchmarkQuestionPreset }> {
  return fetchJson(`/dashboard/benchmark/question-presets/${encodeURIComponent(id)}`, z.object({ preset: DashboardBenchmarkQuestionPresetSchema }), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteBenchmarkQuestionPreset(id: string): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return fetchJson(`/dashboard/benchmark/question-presets/${encodeURIComponent(id)}`, z.object({ ok: z.boolean(), deleted: z.boolean(), id: z.string() }), {
    method: 'DELETE',
  });
}

export function getBenchmarkSessions(limit = 50): Promise<DashboardBenchmarkSessionsResponse> {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  return fetchJson(`/dashboard/benchmark/sessions?${query.toString()}`, DashboardBenchmarkSessionsResponseSchema);
}

export function getBenchmarkSession(id: string): Promise<DashboardBenchmarkSessionDetail> {
  return fetchJson(`/dashboard/benchmark/sessions/${encodeURIComponent(id)}`, DashboardBenchmarkSessionDetailSchema);
}

export function startBenchmarkSession(payload: DashboardBenchmarkStartRequest): Promise<DashboardBenchmarkSessionDetail> {
  return fetchJson('/dashboard/benchmark/sessions', DashboardBenchmarkSessionDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function cancelBenchmarkSession(id: string): Promise<{ ok: boolean; cancelled: boolean; id: string }> {
  return fetchJson(`/dashboard/benchmark/sessions/${encodeURIComponent(id)}/cancel`, z.object({ ok: z.boolean(), cancelled: z.boolean(), id: z.string() }), {
    method: 'POST',
  });
}

export function updateBenchmarkAttemptGrade(
  attemptId: string,
  payload: DashboardBenchmarkGradeRequest,
): Promise<{ attempt: DashboardBenchmarkAttempt }> {
  return fetchJson(`/dashboard/benchmark/attempts/${encodeURIComponent(attemptId)}/grade`, z.object({ attempt: DashboardBenchmarkAttemptSchema }), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function openBenchmarkSessionEvents(
  sessionId: string,
  onEvent: (eventName: string, payload: JsonValue) => void,
): () => void {
  const eventSource = new EventSource(`/dashboard/benchmark/sessions/${encodeURIComponent(sessionId)}/events`);
  const eventNames = ['log', 'attempt', 'session', 'done', 'error'];
  for (const eventName of eventNames) {
    eventSource.addEventListener(eventName, (event) => {
      if (!(event instanceof MessageEvent)) {
        return;
      }
      try {
        const data: JsonValue = JSON.parse(String(event.data));
        onEvent(eventName, data);
      } catch {
        onEvent(eventName, {});
      }
    });
  }
  return () => {
    eventSource.close();
  };
}

export function pickManagedFile(
  target: ManagedFilePickerTarget,
  initialPath: string | null,
): Promise<ManagedFilePickerResponse> {
  return fetchJson('/dashboard/system/pick-file', ManagedFilePickerResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, initialPath }),
  });
}

export function testLlamaCppBaseUrl(
  baseUrl: string,
  healthcheckTimeoutMs: number,
): Promise<LlamaCppConnectionTestResponse> {
  return fetchJson('/config/llama-cpp/test', LlamaCppConnectionTestResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ BaseUrl: baseUrl, HealthcheckTimeoutMs: healthcheckTimeoutMs }),
  });
}

export function getChatSessions(): Promise<ChatSessionsResponse> {
  return fetchJson('/dashboard/chat/sessions', ChatSessionsResponseSchema);
}

export function getChatSession(id: string): Promise<ChatSessionResponse> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(id)}`, ChatSessionResponseSchema);
}

export function deleteChatSession(id: string): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(id)}`, z.object({ ok: z.boolean(), deleted: z.boolean(), id: z.string() }), {
    method: 'DELETE',
  });
}

export function deleteChatMessage(sessionId: string, messageId: string): Promise<ChatSessionResponse> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, ChatSessionResponseSchema, {
    method: 'DELETE',
  });
}

export function createChatSession(payload: {
  title: string;
  model: string;
  contextWindowTokens?: number;
  presetId?: string;
}): Promise<ChatSessionResponse> {
  return fetchJson('/dashboard/chat/sessions', ChatSessionResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateChatSession(
  sessionId: string,
  payload: { title?: string; thinkingEnabled?: boolean; webSearchEnabled?: boolean; presetId?: string; mode?: 'chat' | 'plan' | 'repo-search'; planRepoRoot?: string }
): Promise<ChatSessionResponse> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}`, ChatSessionResponseSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function streamChatMessage(
  sessionId: string,
  payload: { content: string },
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: ChatStreamToolEvent) => void,
  onAnswer: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  return consumeChatStream(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/stream`,
    payload,
    onThinking,
    onToolEvent,
    onAnswer,
  );
}

export function condenseChatSession(sessionId: string): Promise<ChatSessionResponse> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/condense`, ChatSessionResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function getRepoSearchAutoAppendPreview(
  sessionId: string,
  payload: { repoRoot?: string },
): Promise<RepoSearchAutoAppendPreview> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-search/append-preview`, RepoSearchAutoAppendPreviewSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createPlanMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
  }
): Promise<ChatSessionResponse> {
  return fetchJson(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/plan`, ChatSessionResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function consumeChatStream(
  url: string,
  payload: Record<string, JsonSerializable>,
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: ChatStreamToolEvent) => void,
  onAnswer?: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  if (!response.body) {
    throw new Error('Streaming response body was empty.');
  }
  let finalResponse: ChatSessionResponse | null = null;
  const reader = new ChatStreamReader(response.body.getReader());
  for await (const event of reader.events()) {
    if (event.kind === 'thinking') {
      onThinking(event.text);
    } else if (event.kind === 'tool') {
      onToolEvent(event.tool);
    } else if (event.kind === 'answer') {
      if (onAnswer) onAnswer(event.text);
    } else if (event.kind === 'done') {
      finalResponse = event.payload;
    } else if (event.kind === 'error') {
      throw new Error(event.message);
    }
  }
  if (!finalResponse) {
    throw new Error('Missing final streaming payload.');
  }
  return finalResponse;
}

export async function streamPlanMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
    includeAgentsMd?: boolean;
    includeRepoFileListing?: boolean;
  },
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: ChatStreamToolEvent) => void,
  onAnswer?: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  return consumeChatStream(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/plan/stream`,
    payload,
    onThinking,
    onToolEvent,
    onAnswer,
  );
}

export async function streamRepoSearchMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
    includeAgentsMd?: boolean;
    includeRepoFileListing?: boolean;
  },
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: ChatStreamToolEvent) => void,
  onAnswer?: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  return consumeChatStream(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-search/stream`,
    payload,
    onThinking,
    onToolEvent,
    onAnswer,
  );
}
