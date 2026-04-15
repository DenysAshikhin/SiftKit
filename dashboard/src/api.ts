import type {
  DashboardConfig,
  DashboardHealth,
  ChatSessionResponse,
  ChatSessionsResponse,
  IdleSummaryResponse,
  MetricsResponse,
  RunLogDeleteCriteria,
  RunLogDeletePreviewResponse,
  RunLogDeleteResponse,
  RunDetailResponse,
  RunsResponse,
} from './types';

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

export function restartBackend(): Promise<{ ok: boolean; restarted: boolean; error?: string; config?: DashboardConfig }> {
  return fetchJson<{ ok: boolean; restarted: boolean; error?: string; config?: DashboardConfig }>('/status/restart', {
    method: 'POST',
  });
}

export function getDashboardHealth(): Promise<DashboardHealth> {
  return fetchJson<DashboardHealth>('/health');
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
  payload: { title?: string; thinkingEnabled?: boolean; presetId?: string; mode?: 'chat' | 'plan' | 'repo-search'; planRepoRoot?: string }
): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function appendChatMessage(
  sessionId: string,
  payload: { content: string; assistantContent?: string }
): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function streamChatMessage(
  sessionId: string,
  payload: { content: string },
  onThinking: (thinkingText: string) => void,
  onAnswer: (answerText: string) => void
): Promise<ChatSessionResponse> {
  const response = await fetch(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
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

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let finalResponse: ChatSessionResponse | null = null;

  const handlePacket = (packet: string): void => {
    const lines = packet
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return;
    }
    const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    if (eventName === 'thinking' && parsed && typeof parsed === 'object') {
      onThinking(String((parsed as { thinking?: unknown }).thinking || ''));
      return;
    }
    if (eventName === 'answer' && parsed && typeof parsed === 'object') {
      onAnswer(String((parsed as { answer?: unknown }).answer || ''));
      return;
    }
    if (eventName === 'answer' && parsed && typeof parsed === 'object') {
      if (onAnswer) {
        onAnswer(String((parsed as { answer?: unknown }).answer || ''));
      }
      return;
    }
    if (eventName === 'done') {
      finalResponse = parsed as ChatSessionResponse;
      return;
    }
    if (eventName === 'error' && parsed && typeof parsed === 'object') {
      throw new Error(String((parsed as { error?: unknown }).error || 'stream error'));
    }
  };

  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handlePacket(packet);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (!finalResponse) {
    throw new Error('Missing final streaming payload.');
  }
  return finalResponse;
}

export function condenseChatSession(sessionId: string): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/condense`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function clearToolContext(sessionId: string): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/tool-context/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function createPlanMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
    thinkingInterval?: number;
  }
): Promise<ChatSessionResponse> {
  return fetchJson<ChatSessionResponse>(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function streamPlanMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
    thinkingInterval?: number;
  },
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: {
    kind: 'tool_start' | 'tool_result';
    turn: number;
    maxTurns: number;
    command: string;
    exitCode?: number;
    outputSnippet?: string;
    promptTokenCount?: number;
  }) => void,
  onAnswer?: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  const response = await fetch(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/plan/stream`, {
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

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let finalResponse: ChatSessionResponse | null = null;

  const handlePacket = (packet: string): void => {
    const lines = packet
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return;
    }
    const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    if (eventName === 'thinking' && parsed && typeof parsed === 'object') {
      onThinking(String((parsed as { thinking?: unknown }).thinking || ''));
      return;
    }
    if ((eventName === 'tool_start' || eventName === 'tool_result') && parsed && typeof parsed === 'object') {
      const p = parsed as {
        kind?: string;
        turn?: number;
        maxTurns?: number;
        command?: string;
        exitCode?: number;
        outputSnippet?: string;
        promptTokenCount?: number;
      };
      const evt: {
        kind: 'tool_start' | 'tool_result';
        turn: number;
        maxTurns: number;
        command: string;
        exitCode?: number;
        outputSnippet?: string;
        promptTokenCount?: number;
      } = {
        kind: eventName as 'tool_start' | 'tool_result',
        turn: Number(p.turn ?? 0),
        maxTurns: Number(p.maxTurns ?? 0),
        command: String(p.command ?? ''),
      };
      if (typeof p.exitCode === 'number') { evt.exitCode = p.exitCode; }
      if (typeof p.outputSnippet === 'string') { evt.outputSnippet = p.outputSnippet; }
      if (typeof p.promptTokenCount === 'number') { evt.promptTokenCount = p.promptTokenCount; }
      onToolEvent(evt);
      return;
    }
    if (eventName === 'answer' && parsed && typeof parsed === 'object') {
      if (onAnswer) {
        onAnswer(String((parsed as { answer?: unknown }).answer || ''));
      }
      return;
    }
    if (eventName === 'done') {
      finalResponse = parsed as ChatSessionResponse;
      return;
    }
    if (eventName === 'error' && parsed && typeof parsed === 'object') {
      throw new Error(String((parsed as { error?: unknown }).error || 'stream error'));
    }
  };

  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handlePacket(packet);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (!finalResponse) {
    throw new Error('Missing final streaming payload.');
  }
  return finalResponse;
}

export async function streamRepoSearchMessage(
  sessionId: string,
  payload: {
    content: string;
    repoRoot?: string;
    model?: string;
    maxTurns?: number;
    thinkingInterval?: number;
  },
  onThinking: (thinkingText: string) => void,
  onToolEvent: (event: {
    kind: 'tool_start' | 'tool_result';
    turn: number;
    maxTurns: number;
    command: string;
    exitCode?: number;
    outputSnippet?: string;
    promptTokenCount?: number;
  }) => void,
  onAnswer?: (answerText: string) => void,
): Promise<ChatSessionResponse> {
  const response = await fetch(`/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-search/stream`, {
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

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let finalResponse: ChatSessionResponse | null = null;

  const handlePacket = (packet: string): void => {
    const lines = packet
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return;
    }
    const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    if (eventName === 'thinking' && parsed && typeof parsed === 'object') {
      onThinking(String((parsed as { thinking?: unknown }).thinking || ''));
      return;
    }
    if ((eventName === 'tool_start' || eventName === 'tool_result') && parsed && typeof parsed === 'object') {
      const p = parsed as {
        kind?: string;
        turn?: number;
        maxTurns?: number;
        command?: string;
        exitCode?: number;
        outputSnippet?: string;
        promptTokenCount?: number;
      };
      const evt: {
        kind: 'tool_start' | 'tool_result';
        turn: number;
        maxTurns: number;
        command: string;
        exitCode?: number;
        outputSnippet?: string;
        promptTokenCount?: number;
      } = {
        kind: eventName as 'tool_start' | 'tool_result',
        turn: Number(p.turn ?? 0),
        maxTurns: Number(p.maxTurns ?? 0),
        command: String(p.command ?? ''),
      };
      if (typeof p.exitCode === 'number') { evt.exitCode = p.exitCode; }
      if (typeof p.outputSnippet === 'string') { evt.outputSnippet = p.outputSnippet; }
      if (typeof p.promptTokenCount === 'number') { evt.promptTokenCount = p.promptTokenCount; }
      onToolEvent(evt);
      return;
    }
    if (eventName === 'answer' && parsed && typeof parsed === 'object') {
      if (onAnswer) {
        onAnswer(String((parsed as { answer?: unknown }).answer || ''));
      }
      return;
    }
    if (eventName === 'done') {
      finalResponse = parsed as ChatSessionResponse;
      return;
    }
    if (eventName === 'error' && parsed && typeof parsed === 'object') {
      throw new Error(String((parsed as { error?: unknown }).error || 'stream error'));
    }
  };

  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handlePacket(packet);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (!finalResponse) {
    throw new Error('Missing final streaming payload.');
  }
  return finalResponse;
}
