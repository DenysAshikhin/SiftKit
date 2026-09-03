import { syncDerivedSettingsFields } from '../settings-runtime.js';
import telemetryMetrics from '../../../src/lib/telemetry-metrics.js';
import type { JsonValue, JsonObject, OptionalJsonValue } from '../../../src/lib/json-types.js';
import { sumImageTokens } from '@siftkit/contracts';
import type {
  ChatMessage,
  ChatSession,
  DashboardConfig,
  RunDetailResponse,
  RunGroupFilter,
  RunRecord,
} from '../types.js';
import { estimatePromptTokens } from './chatMessages.js';
import type { ChatTurn } from './chatTurns.js';

const {
  getAcceptanceRate,
  getGenerationTokensPerSecond,
  getPromptCacheHitRate,
  getPromptTokensPerSecond,
} = telemetryMetrics;

export type RunGroupKey = Exclude<RunGroupFilter, ''>;

export function readSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') {
    return new URLSearchParams();
  }
  return new URLSearchParams(window.location.search);
}

export function writeSearchParams(update: Record<string, string | null>): void {
  if (typeof window === 'undefined') {
    return;
  }
  const params = readSearchParams();
  for (const [key, value] of Object.entries(update)) {
    if (value && value.trim()) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function formatNumber(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return Number(value).toLocaleString();
}

export function formatTokenLabel(value: number | null, exactLabel = 'tokens'): string {
  return value === null ? 'tokens unavailable' : `${formatNumber(value)} ${exactLabel}`;
}

export function formatDate(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function readTokenCount(value: OptionalJsonValue): number {
  const tokenCount = Number(value);
  return Number.isFinite(tokenCount) && tokenCount >= 0 ? tokenCount : 0;
}

type TokenComponent = {
  tokenCount: number;
  exact: boolean;
};

type MessageTokenComponents = {
  input: TokenComponent;
  output: TokenComponent;
  thinking: TokenComponent;
};

function readTokenComponent(value: OptionalJsonValue, estimated: boolean | undefined): TokenComponent {
  const tokenCount = readTokenCount(value);
  return { tokenCount, exact: tokenCount <= 0 || estimated === false };
}

function getMessageTokenComponents(message: ChatMessage): MessageTokenComponents {
  return {
    input: readTokenComponent(message.inputTokensEstimate, message.inputTokensEstimated),
    output: readTokenComponent(message.outputTokensEstimate, message.outputTokensEstimated),
    thinking: readTokenComponent(message.thinkingTokens, message.thinkingTokensEstimated),
  };
}

export function getMessageTokenCount(message: ChatMessage): number | null {
  const components = getMessageTokenComponents(message);
  if (!components.input.exact || !components.output.exact || !components.thinking.exact) {
    return null;
  }
  return components.input.tokenCount + components.output.tokenCount + components.thinking.tokenCount;
}

export function getMessageKnownTokenCount(message: ChatMessage): number {
  const components = getMessageTokenComponents(message);
  return (components.input.exact ? components.input.tokenCount : 0)
    + (components.output.exact ? components.output.tokenCount : 0)
    + (components.thinking.exact ? components.thinking.tokenCount : 0);
}

export function getReplayDisplayTokenCount(message: ChatMessage): number | null {
  return getMessageTokenCount(message);
}

export function formatMessageTokenLabel(message: ChatMessage): string {
  const textTokens = getReplayDisplayTokenCount(message);
  const imageTokens = sumImageTokens(message.imageMeta);
  if (textTokens === 0 && imageTokens > 0) {
    return `${formatNumber(imageTokens)} image tokens`;
  }
  const textLabel = formatTokenLabel(textTokens);
  return imageTokens > 0 ? `${textLabel} (+${formatNumber(imageTokens)} img)` : textLabel;
}

type TokenDisplay = {
  tokenCount: number;
  exact: boolean;
  imageTokens: number;
};

export function getLiveMessageTokenDisplay(message: ChatMessage): TokenDisplay {
  const components = getMessageTokenComponents(message);
  const numericTextTokens = components.input.tokenCount
    + components.output.tokenCount
    + components.thinking.tokenCount;
  const content = message.kind === 'assistant_tool_call'
    ? String(message.toolCallCommand || message.content || '').trim()
    : String(message.content || '').trim();
  const contentTokens = numericTextTokens === 0 && content ? estimatePromptTokens(content) : 0;
  const toolCommandTokens = message.kind === 'assistant_tool_call' && numericTextTokens > 0 && content
    ? estimatePromptTokens(content)
    : 0;
  const imageTokens = sumImageTokens(message.imageMeta);
  const exact = contentTokens === 0
    && toolCommandTokens === 0
    && components.input.exact
    && components.output.exact
    && components.thinking.exact;
  return {
    tokenCount: numericTextTokens + contentTokens + toolCommandTokens + imageTokens,
    exact,
    imageTokens,
  };
}

export function formatLiveMessageTokenLabel(message: ChatMessage): string {
  const display = getLiveMessageTokenDisplay(message);
  const textTokens = display.tokenCount - display.imageTokens;
  if (textTokens === 0 && display.imageTokens > 0) {
    return `${formatNumber(display.imageTokens)} image tokens`;
  }
  const textLabel = `${display.exact ? '' : '~'}${formatNumber(textTokens)} tokens`;
  return display.imageTokens > 0
    ? `${textLabel} (+${formatNumber(display.imageTokens)} img)`
    : textLabel;
}

export function getTurnTokenDisplay(turn: ChatTurn): { tokenCount: number; exact: boolean } {
  if (turn.isLive || !turn.main) {
    const displays = turn.messages.map(getLiveMessageTokenDisplay);
    return {
      tokenCount: displays.reduce((sum, display) => sum + display.tokenCount, 0),
      exact: displays.every((display) => display.exact),
    };
  }

  const main = turn.main;
  const components = getMessageTokenComponents(main);
  const numericGenerationTokens = components.output.tokenCount + components.thinking.tokenCount;
  const content = String(main.content || '').trim();
  const contentTokens = numericGenerationTokens === 0 && content ? estimatePromptTokens(content) : 0;
  const associatedToolTokens = readTokenCount(main.associatedToolTokens);
  const imageTokens = turn.messages.reduce((sum, message) => sum + sumImageTokens(message.imageMeta), 0);
  let toolTokensExact = true;
  for (const message of turn.messages) {
    if (message.kind === 'assistant_tool_call' && !getMessageTokenComponents(message).output.exact) {
      toolTokensExact = false;
    }
  }
  return {
    tokenCount: numericGenerationTokens + contentTokens + associatedToolTokens + imageTokens,
    exact: contentTokens === 0
      && components.output.exact
      && components.thinking.exact
      && toolTokensExact,
  };
}

export function getSessionTelemetryStats(session: ChatSession | null): {
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  acceptanceRate: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
} {
  if (!session || !Array.isArray(session.messages)) {
    return {
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
      speculativeAcceptedTokens: 0,
      speculativeGeneratedTokens: 0,
      acceptanceRate: null,
      promptTokensPerSecond: null,
      generationTokensPerSecond: null,
    };
  }
  const getIsoTime = (value: string | null | undefined): number | null => {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const getPromptTokensForTurn = (message: ChatMessage, previousMessage: ChatMessage | null): number | null => {
    if (Number.isFinite(message.promptEvalTokens) && Number(message.promptEvalTokens) >= 0) {
      return Number(message.promptEvalTokens);
    }
    if (
      previousMessage
      && previousMessage.role === 'user'
      && Number.isFinite(previousMessage.inputTokensEstimate)
      && Number(previousMessage.inputTokensEstimate) >= 0
    ) {
      return Number(previousMessage.inputTokensEstimate);
    }
    return null;
  };
  let promptDurationMsTotal = 0;
  let promptTokensForRateTotal = 0;
  let outputDurationMsTotal = 0;
  let generatedTokensForRateTotal = 0;
  const promptCacheTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.promptCacheTokens) && Number(message.promptCacheTokens) >= 0
      ? sum + Number(message.promptCacheTokens)
      : sum
  ), 0);
  const promptEvalTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.promptEvalTokens) && Number(message.promptEvalTokens) >= 0
      ? sum + Number(message.promptEvalTokens)
      : sum
  ), 0);
  const speculativeAcceptedTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.speculativeAcceptedTokens) && Number(message.speculativeAcceptedTokens) >= 0
      ? sum + Number(message.speculativeAcceptedTokens)
      : sum
  ), 0);
  const speculativeGeneratedTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.speculativeGeneratedTokens) && Number(message.speculativeGeneratedTokens) >= 0
      ? sum + Number(message.speculativeGeneratedTokens)
      : sum
  ), 0);
  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== 'assistant') {
      continue;
    }
    const previousMessage = index > 0 ? (session.messages[index - 1] ?? null) : null;
    const requestStartedAt = getIsoTime(message.requestStartedAtUtc);
    const thinkingStartedAt = getIsoTime(message.thinkingStartedAtUtc);
    const answerStartedAt = getIsoTime(message.answerStartedAtUtc);
    const answerEndedAt = getIsoTime(message.answerEndedAtUtc);
    const generationStartedAt = thinkingStartedAt ?? answerStartedAt;
    const promptTokens = getPromptTokensForTurn(message, previousMessage);
    const promptTokensPerSecond = Number.isFinite(message.promptTokensPerSecond) && Number(message.promptTokensPerSecond) > 0
      ? Number(message.promptTokensPerSecond)
      : null;
    const promptDurationMs = (
      promptTokensPerSecond !== null && promptTokens !== null
        ? (promptTokens / promptTokensPerSecond) * 1000
        : Number.isFinite(message.promptEvalDurationMs) && Number(message.promptEvalDurationMs) > 0
        ? Number(message.promptEvalDurationMs)
        : (requestStartedAt !== null && generationStartedAt !== null && generationStartedAt > requestStartedAt)
            ? generationStartedAt - requestStartedAt
            : null
    );
    if (promptDurationMs !== null && promptDurationMs > 0 && promptTokens !== null) {
      promptDurationMsTotal += promptDurationMs;
      promptTokensForRateTotal += promptTokens;
    }
    const thinkingTokens = Number.isFinite(message.thinkingTokens) && Number(message.thinkingTokens) >= 0
      ? Number(message.thinkingTokens)
      : 0;
    const outputTokensForDirectRate = Number.isFinite(message.outputTokensEstimate) && Number(message.outputTokensEstimate) >= 0
      ? Number(message.outputTokensEstimate)
      : 0;
    const generationTokensPerSecond = Number.isFinite(message.generationTokensPerSecond) && Number(message.generationTokensPerSecond) > 0
      ? Number(message.generationTokensPerSecond)
      : null;
    const generatedTokens = thinkingTokens + outputTokensForDirectRate;
    const generationDurationMs = (
      generationTokensPerSecond !== null && generatedTokens > 0
        ? (generatedTokens / generationTokensPerSecond) * 1000
        : Number.isFinite(message.generationDurationMs) && Number(message.generationDurationMs) > 0
        ? Number(message.generationDurationMs)
        : (generationStartedAt !== null && answerEndedAt !== null && answerEndedAt > generationStartedAt)
            ? answerEndedAt - generationStartedAt
            : null
    );
    if (generationDurationMs !== null && generationDurationMs > 0) {
      outputDurationMsTotal += generationDurationMs;
      generatedTokensForRateTotal += generatedTokens;
    }
  }
  return {
    promptCacheTokens,
    promptEvalTokens,
    cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
    speculativeAcceptedTokens,
    speculativeGeneratedTokens,
    acceptanceRate: getAcceptanceRate(speculativeAcceptedTokens, speculativeGeneratedTokens),
    promptTokensPerSecond: getPromptTokensPerSecond(promptTokensForRateTotal, promptDurationMsTotal),
    generationTokensPerSecond: getGenerationTokensPerSecond(generatedTokensForRateTotal, 0, outputDurationMsTotal),
  };
}

export type LastTurnTelemetry = {
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  ttftMs: number | null;
};

function readPositiveTokenRate(value: OptionalJsonValue): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

/**
 * The HUD reports the newest completed turn, not the running average, so a slow prompt
 * shows up the moment it happens. Rates only ride the terminal `done` payload, so this
 * never sees an in-flight turn.
 */
export function getLastTurnTelemetry(session: ChatSession | null): LastTurnTelemetry {
  const empty: LastTurnTelemetry = {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  };
  if (!session || !Array.isArray(session.messages)) {
    return empty;
  }
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!message || message.role !== 'assistant') {
      continue;
    }
    const promptTokensPerSecond = readPositiveTokenRate(message.promptTokensPerSecond);
    const generationTokensPerSecond = readPositiveTokenRate(message.generationTokensPerSecond);
    const ttftMs = readPositiveTokenRate(message.promptEvalDurationMs);
    if (promptTokensPerSecond === null && generationTokensPerSecond === null && ttftMs === null) {
      continue;
    }
    return { promptTokensPerSecond, generationTokensPerSecond, ttftMs };
  }
  return empty;
}

export function classifyRunGroup(kind: string): RunGroupKey {
  const normalized = kind.trim().toLowerCase();
  if (normalized.includes('repo_search')) {
    return 'repo_search';
  }
  if (normalized.includes('chat')) {
    return 'chat';
  }
  if (normalized.includes('planner')) {
    return 'planner';
  }
  if (normalized.includes('summary') || normalized.includes('request')) {
    return 'summary';
  }
  return 'other';
}

export function runGroupLabel(group: RunGroupKey): string {
  if (group === 'repo_search') {
    return 'Repo Search';
  }
  if (group === 'planner') {
    return 'Planner';
  }
  if (group === 'chat') {
    return 'Chat';
  }
  if (group === 'summary') {
    return 'Summary';
  }
  return 'Other';
}

export function formatPercent(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${(Number(value) * 100).toFixed(2)}%`;
}

export function formatSecondsFromMs(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${(Number(value) / 1000).toFixed(2)}s`;
}

export function formatDurationHms(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  const totalSeconds = Math.max(0, Math.round(Number(value) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${hh}:${mm}:${ss} (${hh}h ${mm}m ${ss}s)`;
}

export function formatShortTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

export function formatTaskKindLabel(taskKind: string): string {
  if (taskKind === 'repo-search') {
    return 'Repo Search';
  }
  if (taskKind === 'plan') {
    return 'Plan';
  }
  if (taskKind === 'summary') {
    return 'Summary';
  }
  if (taskKind === 'chat') {
    return 'Chat';
  }
  return taskKind;
}

export function formatTaskKindClass(taskKind: string): string {
  const normalized = String(taskKind || '').trim().toLowerCase();
  if (!normalized) {
    return 'other';
  }
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

export function isRecord(value: OptionalJsonValue): value is JsonObject {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

export function readStringField(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function readNumberField(record: JsonObject, key: string): number | null {
  const value = record[key];
  return Number.isFinite(value) ? Number(value) : null;
}

export function formatCompactTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(Math.round(value));
}

export function formatStepContextUsed(payload: JsonObject): string | null {
  const promptTokenCount = readNumberField(payload, 'promptTokenCount');
  const remainingTokenAllowance = readNumberField(payload, 'remainingTokenAllowance');
  if (promptTokenCount === null || remainingTokenAllowance === null) {
    return null;
  }
  const totalBudget = promptTokenCount + remainingTokenAllowance;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) {
    return null;
  }
  const usedPercent = Math.max(0, Math.min(100, Math.round((promptTokenCount / totalBudget) * 100)));
  return `${formatCompactTokenCount(promptTokenCount)} (${usedPercent}%)`;
}

export function extractRunFinalOutput(detail: RunDetailResponse): string | null {
  const events = detail.events;
  for (const event of events) {
    if (event.kind !== 'planner_debug' || !isRecord(event.payload)) {
      continue;
    }
    const finalNode = isRecord(event.payload.final) ? event.payload.final : null;
    if (!finalNode) {
      continue;
    }
    const finalOutput = readStringField(finalNode, 'finalOutput');
    if (finalOutput) {
      return finalOutput;
    }
  }
  for (const event of events) {
    if (event.kind !== 'summary_request' || !isRecord(event.payload)) {
      continue;
    }
    const summary = readStringField(event.payload, 'summary');
    if (summary) {
      return summary;
    }
  }
  const modelResponses = events
    .map((event) => (event.kind === 'turn_model_response' && isRecord(event.payload)
      ? readStringField(event.payload, 'text')
      : null))
    .filter((value): value is string => Boolean(value));
  if (modelResponses.length > 0) {
    return modelResponses[modelResponses.length - 1] ?? null;
  }
  return null;
}

export function buildRunsSignature(items: RunRecord[]): string {
  return items
    .map((item) => `${item.id}|${item.status}|${item.kind}|${item.startedAtUtc || ''}|${item.finishedAtUtc || ''}`)
    .join('||');
}

export function normalizeFinalOutputText(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  let text = trimmed;
  try {
    const parsed: JsonValue = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const outputText = readStringField(parsed, 'output')
        || readStringField(parsed, 'finalOutput')
        || readStringField(parsed, 'summary');
      if (outputText) {
        text = outputText;
      } else {
        text = JSON.stringify(parsed, null, 2);
      }
    }
  } catch {
    text = trimmed;
  }
  return text
    .replace(/\\r\\n/gu, '\n')
    .replace(/\\n/gu, '\n')
    .replace(/\\t/gu, '\t');
}

export function formatRunEventPayload(event: { kind: string; payload: JsonValue }): string {
  if (!isRecord(event.payload)) {
    return `\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``;
  }
  const payload = event.payload;
  const scalarLines: string[] = [];
  const blockLines: string[] = [];
  const preferredTextFields = [
    'prompt',
    'text',
    'thinkingText',
    'output',
    'insertedResultText',
    'error',
    'warning',
  ];
  if (typeof payload.taskId === 'string' && payload.taskId.trim()) {
    scalarLines.push(`- Task: \`${payload.taskId}\``);
  }
  if (Number.isFinite(payload.turn)) {
    scalarLines.push(`- Turn: ${String(payload.turn)}`);
  }
  if (typeof payload.command === 'string' && payload.command.trim()) {
    scalarLines.push(`- Command: \`${payload.command.trim()}\``);
  }
  for (const field of preferredTextFields) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    blockLines.push(`**${field}**`);
    blockLines.push('```text');
    blockLines.push(normalizeFinalOutputText(value));
    blockLines.push('```');
  }
  const remaining: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'taskId' || key === 'turn' || key === 'command' || preferredTextFields.includes(key)) {
      continue;
    }
    remaining[key] = value;
  }
  if (Object.keys(remaining).length > 0) {
    blockLines.push('**metadata**');
    blockLines.push('```json');
    blockLines.push(JSON.stringify(remaining, null, 2));
    blockLines.push('```');
  }
  if (scalarLines.length === 0 && blockLines.length === 0) {
    return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }
  return [...scalarLines, '', ...blockLines].join('\n').trim();
}

export function extractFinishOutput(raw: string): string {
  const marker = /"output"\s*:\s*"/;
  const match = marker.exec(raw);
  if (!match) {
    return raw;
  }
  const start = match.index + match[0].length;
  let content = raw.slice(start);
  if (content.endsWith('"}') || content.endsWith('"\n}')) {
    content = content.slice(0, content.lastIndexOf('"'));
  }
  return content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function cloneDashboardConfig(config: DashboardConfig): DashboardConfig {
  return syncDerivedSettingsFields(structuredClone(config));
}

export function getDashboardConfigSignature(config: DashboardConfig | null): string {
  return config ? JSON.stringify(config) : '';
}

export function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
