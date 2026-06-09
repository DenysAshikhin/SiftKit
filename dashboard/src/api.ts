import type {
  DashboardConfig,
  DashboardHealth,
  ChatSessionResponse,
  ChatSessionsResponse,
  IdleSummaryResponse,
  MetricsResponse,
  ManagedFilePickerResponse,
  ManagedFilePickerTarget,
  LlamaCppConnectionTestResponse,
  RestartBackendResponse,
  RunLogDeleteCriteria,
  RunLogDeletePreviewResponse,
  RunLogDeleteResponse,
  RunDetailResponse,
  RunsResponse,
  DashboardBenchmarkAttempt,
  DashboardBenchmarkGradeRequest,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkQuestionPresetsResponse,
  DashboardBenchmarkSessionDetail,
  DashboardBenchmarkSessionsResponse,
  DashboardBenchmarkStartRequest,
  RepoSearchAutoAppendPreview,
  WebSearchQuotaResponse,
} from './types';
import { ChatStreamReader, type ChatStreamToolEvent } from './lib/chat-stream-parser';

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<T>;
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
  return fetchJson<RunsResponse>(`/dashboard/runs${suffix ? `?${suffix}` : ''}`);
}

export function getRunDetail(id: string): Promise<RunDetailResponse> {
  return fetchJson<RunDetailResponse>(`/dashboard/runs/${encodeURIComponent(id)}`);
}

export function previewRunLogDelete(criteria: RunLogDeleteCriteria): Promise<RunLogDeletePreviewResponse> {
  return fetchJson<RunLogDeletePreviewResponse>('/dashboard/admin/run-logs/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
}

export function deleteRunLogs(criteria: RunLogDeleteCriteria): Promise<RunLogDeleteResponse> {
  return fetchJson<RunLogDeleteResponse>('/dashboard/admin/run-logs', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
}

export function getMetrics(): Promise<MetricsResponse> {
  return fetchJson<MetricsResponse>('/dashboard/metrics/timeseries');
}

export function getWebSearchQuota(): Promise<WebSearchQuotaResponse> {
  return fetchJson<WebSearchQuotaResponse>('/dashboard/web-search-quota');
}

export function getIdleSummary(limit = 30): Promise<IdleSummaryResponse> {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  return fetchJson<IdleSummaryResponse>(`/dashboard/metrics/idle-summary?${query.toString()}`);
}

export function getDashboardConfig(): Promise<DashboardConfig> {
  return fetchJson<DashboardConfig>('/config?skip_ready=1').catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/Request failed \(404\)/u.test(message)) {
      return fetchJson<DashboardConfig>('/config');
    }
    throw error;
  });
}

export function updateDashboardConfig(config: DashboardConfig): Promise<DashboardConfig> {
  return fetchJson<DashboardConfig>('/config', {
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
  let payload: RestartBackendResponse;
  try {
    payload = (text ? JSON.parse(text) : {}) as RestartBackendResponse;
  } catch {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  if (!response.ok && (!payload || typeof payload !== 'object')) {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return payload;
}

export function getDashboardHealth(): Promise<DashboardHealth> {
  return fetchJson<DashboardHealth>('/health');
}

export function getBenchmarkQuestionPresets(): Promise<DashboardBenchmarkQuestionPresetsResponse> {
  return fetchJson<DashboardBenchmarkQuestionPresetsResponse>('/dashboard/benchmark/question-presets');
}

export function createBenchmarkQuestionPreset(payload: {
  title: string;
  taskKind: 'repo-search' | 'summary';
  prompt: string;
  enabled: boolean;
}): Promise<{ preset: DashboardBenchmarkQuestionPreset }> {
  return fetchJson<{ preset: DashboardBenchmarkQuestionPreset }>('/dashboard/benchmark/question-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateBenchmarkQuestionPreset(
  id: string,
  payload: Partial<Pick<DashboardBenchmarkQuestionPreset, 'title' | 'taskKind' | 'prompt' | 'enabled'>>,
): Promise<{ preset: DashboardBenchmarkQuestionPreset }> {
  return fetchJson<{ preset: DashboardBenchmarkQuestionPreset }>(`/dashboard/benchmark/question-presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteBenchmarkQuestionPreset(id: string): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return fetchJson<{ ok: boolean; deleted: boolean; id: string }>(`/dashboard/benchmark/question-presets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function getBenchmarkSessions(limit = 50): Promise<DashboardBenchmarkSessionsResponse> {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  return fetchJson<DashboardBenchmarkSessionsResponse>(`/dashboard/benchmark/sessions?${query.toString()}`);
}

export function getBenchmarkSession(id: string): Promise<DashboardBenchmarkSessionDetail> {
  return fetchJson<DashboardBenchmarkSessionDetail>(`/dashboard/benchmark/sessions/${encodeURIComponent(id)}`);
}

export function startBenchmarkSession(payload: DashboardBenchmarkStartRequest): Promise<DashboardBenchmarkSessionDetail> {
  return fetchJson<DashboardBenchmarkSessionDetail>('/dashboard/benchmark/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function cancelBenchmarkSession(id: string): Promise<{ ok: boolean; cancelled: boolean; id: string }> {
  return fetchJson<{ ok: boolean; cancelled: boolean; id: string }>(`/dashboard/benchmark/sessions/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export function updateBenchmarkAttemptGrade(
  attemptId: string,
  payload: DashboardBenchmarkGradeRequest,
): Promise<{ attempt: DashboardBenchmarkAttempt }> {
  return fetchJson<{ attempt: DashboardBenchmarkAttempt }>(`/dashboard/benchmark/attempts/${encodeURIComponent(attemptId)}/grade`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function openBenchmarkSessionEvents(
  sessionId: string,
  onEvent: (eventName: string, payload: unknown) => void,
): () => void {
  const eventSource = new EventSource(`/dashboard/benchmark/sessions/${encodeURIComponent(sessionId)}/events`);
  const eventNames = ['log', 'attempt', 'session', 'done', 'error'];
  for (const eventName of eventNames) {
    eventSource.addEventListener(eventName, (event) => {
      try {
        onEvent(eventName, JSON.parse((event as MessageEvent).data) as unknown);
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
  return fetchJson<ManagedFilePickerResponse>('/dashboard/system/pick-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, initialPath }),
  });
}

export function testLlamaCppBaseUrl(
  baseUrl: string,
  healthcheckTimeoutMs: number,
): Promise<LlamaCppConnectionTestResponse> {
  return fetchJson<LlamaCppConnectionTestResponse>('/config/llama-cpp/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ BaseUrl: baseUrl, HealthcheckTimeoutMs: healthcheckTimeoutMs }),
  });
}

export function getChatSessions(): Promise<ChatSessionsResponse> {
  return fetchJson<ChatSessionsResponse>('/dashboard/chat/sessions');
}

export function getChatSession(id: string): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(id)}`);
}

export function deleteChatSession(id: string): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return fetchJson<{ ok: boolean; deleted: boolean; id: string }>(`/dashboard/chat/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function deleteChatMessage(sessionId: string, messageId: string): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  });
}

export function createChatSession(payload: {
  title: string;
  model: string;
  contextWindowTokens?: number;
  presetId?: string;
}): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>('/dashboard/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateChatSession(
  sessionId: string,
  payload: { title?: string; thinkingEnabled?: boolean; webSearchEnabled?: boolean; presetId?: string; mode?: 'chat' | 'plan' | 'repo-search'; planRepoRoot?: string }
): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}`, {
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
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/condense`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function getRepoSearchAutoAppendPreview(
  sessionId: string,
  payload: { repoRoot?: string },
): Promise<RepoSearchAutoAppendPreview> {
  return fetchJson<RepoSearchAutoAppendPreview>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-search/append-preview`, {
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
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function consumeChatStream(
  url: string,
  payload: unknown,
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
