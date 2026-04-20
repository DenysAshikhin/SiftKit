import type { Dict } from '../lib/types.js';
import { createEmptyToolTypeStats } from '../line-read-guidance.js';
import type { TaskKind, ToolTypeStats } from './metrics.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';

export const STATUS_TRUE = 'true';
export const STATUS_FALSE = 'false';

export function normalizeStatusText(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
    return normalized;
  }
  return STATUS_FALSE;
}

export function ensureStatusFile(targetPath: string): void {
  const database = getRuntimeDatabase(targetPath);
  const row = database.prepare('SELECT status_text FROM runtime_status WHERE id = 1').get() as { status_text?: unknown } | undefined;
  const normalized = row && typeof row.status_text === 'string'
    ? normalizeStatusText(row.status_text)
    : STATUS_FALSE;
  database.prepare(`
    INSERT INTO runtime_status (id, status_text, updated_at_utc)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status_text = excluded.status_text,
      updated_at_utc = excluded.updated_at_utc
  `).run(normalized, new Date().toISOString());
}

export function readStatusText(targetPath: string): string {
  try {
    const database = getRuntimeDatabase(targetPath);
    const row = database.prepare('SELECT status_text FROM runtime_status WHERE id = 1').get() as { status_text?: unknown } | undefined;
    if (!row || typeof row.status_text !== 'string') {
      return STATUS_FALSE;
    }
    return normalizeStatusText(row.status_text);
  } catch {
    return STATUS_FALSE;
  }
}

export function writeStatusText(targetPath: string, value: unknown): void {
  const database = getRuntimeDatabase(targetPath);
  database.prepare(`
    INSERT INTO runtime_status (id, status_text, updated_at_utc)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status_text = excluded.status_text,
      updated_at_utc = excluded.updated_at_utc
  `).run(normalizeStatusText(value), new Date().toISOString());
}

export function parseRunning(bodyText: string): boolean | null {
  if (!bodyText || !bodyText.trim()) {
    return null;
  }
  const parseBooleanLikeStatus = (value: unknown): boolean | null => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = normalizeStatusText(value);
      if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
        return normalized === STATUS_TRUE;
      }
    }
    return null;
  };
  try {
    const parsed = JSON.parse(bodyText) as Dict;
    const running = parseBooleanLikeStatus(parsed.running);
    if (running !== null) {
      return running;
    }
    const status = parseBooleanLikeStatus(parsed.status);
    if (status !== null) {
      return status;
    }
  } catch {
    const normalized = normalizeStatusText(bodyText);
    if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
      return normalized === STATUS_TRUE;
    }
  }
  return null;
}

export type StatusMetadata = {
  requestId: string | null;
  taskKind: TaskKind | null;
  terminalState: string | null;
  errorMessage: string | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  rawInputCharacterCount: number | null;
  chunkInputCharacterCount: number | null;
  budgetSource: string | null;
  inputCharactersPerContextToken: number | null;
  chunkThresholdCharacters: number | null;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  inputTokens: number | null;
  outputCharacterCount: number | null;
  outputTokens: number | null;
  toolTokens: number | null;
  thinkingTokens: number | null;
  toolStats: Record<string, ToolTypeStats> | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  requestDurationMs: number | null;
  artifactType: string | null;
  artifactRequestId: string | null;
  artifactPayload: Dict | null;
  totalOutputTokens?: number | null;
};

export function parseStatusMetadata(bodyText: string): StatusMetadata {
  const metadata: StatusMetadata = {
    requestId: null,
    taskKind: null,
    terminalState: null,
    errorMessage: null,
    promptCharacterCount: null,
    promptTokenCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
    budgetSource: null,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    chunkIndex: null,
    chunkTotal: null,
    chunkPath: null,
    inputTokens: null,
    outputCharacterCount: null,
    outputTokens: null,
    toolTokens: null,
    thinkingTokens: null,
    toolStats: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    requestDurationMs: null,
    artifactType: null,
    artifactRequestId: null,
    artifactPayload: null,
  };
  if (!bodyText || !bodyText.trim()) {
    return metadata;
  }
  try {
    const parsed = JSON.parse(bodyText) as Dict;
    if (typeof parsed.requestId === 'string' && parsed.requestId.trim()) {
      metadata.requestId = parsed.requestId.trim();
    }
    if (
      parsed.taskKind === 'summary'
      || parsed.taskKind === 'plan'
      || parsed.taskKind === 'repo-search'
      || parsed.taskKind === 'chat'
    ) {
      metadata.taskKind = parsed.taskKind;
    }
    if (parsed.terminalState === 'completed' || parsed.terminalState === 'failed') {
      metadata.terminalState = parsed.terminalState;
    }
    if (typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim()) {
      metadata.errorMessage = parsed.errorMessage.trim();
    }
    if (Number.isFinite(parsed.promptCharacterCount) && Number(parsed.promptCharacterCount) >= 0) {
      metadata.promptCharacterCount = Number(parsed.promptCharacterCount);
    } else if (Number.isFinite(parsed.characterCount) && Number(parsed.characterCount) >= 0) {
      metadata.promptCharacterCount = Number(parsed.characterCount);
    }
    if (Number.isFinite(parsed.promptTokenCount) && Number(parsed.promptTokenCount) >= 0) {
      metadata.promptTokenCount = Number(parsed.promptTokenCount);
    }
    if (Number.isFinite(parsed.rawInputCharacterCount) && Number(parsed.rawInputCharacterCount) >= 0) {
      metadata.rawInputCharacterCount = Number(parsed.rawInputCharacterCount);
    }
    if (Number.isFinite(parsed.chunkInputCharacterCount) && Number(parsed.chunkInputCharacterCount) >= 0) {
      metadata.chunkInputCharacterCount = Number(parsed.chunkInputCharacterCount);
    }
    if (typeof parsed.budgetSource === 'string' && parsed.budgetSource.trim()) {
      metadata.budgetSource = parsed.budgetSource.trim();
    }
    if (Number.isFinite(parsed.inputCharactersPerContextToken) && Number(parsed.inputCharactersPerContextToken) > 0) {
      metadata.inputCharactersPerContextToken = Number(parsed.inputCharactersPerContextToken);
    }
    if (Number.isFinite(parsed.chunkThresholdCharacters) && Number(parsed.chunkThresholdCharacters) > 0) {
      metadata.chunkThresholdCharacters = Number(parsed.chunkThresholdCharacters);
    }
    if (Number.isFinite(parsed.chunkIndex) && Number(parsed.chunkIndex) > 0) {
      metadata.chunkIndex = Number(parsed.chunkIndex);
    }
    if (Number.isFinite(parsed.chunkTotal) && Number(parsed.chunkTotal) > 0) {
      metadata.chunkTotal = Number(parsed.chunkTotal);
    }
    if (typeof parsed.chunkPath === 'string' && parsed.chunkPath.trim()) {
      metadata.chunkPath = parsed.chunkPath.trim();
    }
    if (Number.isFinite(parsed.inputTokens) && Number(parsed.inputTokens) >= 0) {
      metadata.inputTokens = Number(parsed.inputTokens);
    }
    if (Number.isFinite(parsed.outputCharacterCount) && Number(parsed.outputCharacterCount) >= 0) {
      metadata.outputCharacterCount = Number(parsed.outputCharacterCount);
    }
    if (Number.isFinite(parsed.outputTokens) && Number(parsed.outputTokens) >= 0) {
      metadata.outputTokens = Number(parsed.outputTokens);
    }
    if (Number.isFinite(parsed.toolTokens) && Number(parsed.toolTokens) >= 0) {
      metadata.toolTokens = Number(parsed.toolTokens);
    }
    if (Number.isFinite(parsed.thinkingTokens) && Number(parsed.thinkingTokens) >= 0) {
      metadata.thinkingTokens = Number(parsed.thinkingTokens);
    }
    if (parsed.toolStats && typeof parsed.toolStats === 'object' && !Array.isArray(parsed.toolStats)) {
      const normalizedToolStats: Record<string, ToolTypeStats> = {};
      for (const [toolTypeRaw, rawStats] of Object.entries(parsed.toolStats as Dict)) {
        const toolType = String(toolTypeRaw || '').trim();
        if (!toolType || !rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
          continue;
        }
        const statsRecord = rawStats as Dict;
        const calls = Number.isFinite(statsRecord.calls) && Number(statsRecord.calls) >= 0
          ? Number(statsRecord.calls)
          : 0;
        const outputCharsTotal = Number.isFinite(statsRecord.outputCharsTotal) && Number(statsRecord.outputCharsTotal) >= 0
          ? Number(statsRecord.outputCharsTotal)
          : 0;
        const outputTokensTotal = Number.isFinite(statsRecord.outputTokensTotal) && Number(statsRecord.outputTokensTotal) >= 0
          ? Number(statsRecord.outputTokensTotal)
          : 0;
        const outputTokensEstimatedCount = Number.isFinite(statsRecord.outputTokensEstimatedCount) && Number(statsRecord.outputTokensEstimatedCount) >= 0
          ? Number(statsRecord.outputTokensEstimatedCount)
          : 0;
        const lineReadCalls = Number.isFinite(statsRecord.lineReadCalls) && Number(statsRecord.lineReadCalls) >= 0
          ? Number(statsRecord.lineReadCalls)
          : 0;
        const lineReadLinesTotal = Number.isFinite(statsRecord.lineReadLinesTotal) && Number(statsRecord.lineReadLinesTotal) >= 0
          ? Number(statsRecord.lineReadLinesTotal)
          : 0;
        const lineReadTokensTotal = Number.isFinite(statsRecord.lineReadTokensTotal) && Number(statsRecord.lineReadTokensTotal) >= 0
          ? Number(statsRecord.lineReadTokensTotal)
          : 0;
        const finishRejections = Number.isFinite(statsRecord.finishRejections) && Number(statsRecord.finishRejections) >= 0
          ? Number(statsRecord.finishRejections)
          : 0;
        const semanticRepeatRejects = Number.isFinite(statsRecord.semanticRepeatRejects) && Number(statsRecord.semanticRepeatRejects) >= 0
          ? Number(statsRecord.semanticRepeatRejects)
          : 0;
        const stagnationWarnings = Number.isFinite(statsRecord.stagnationWarnings) && Number(statsRecord.stagnationWarnings) >= 0
          ? Number(statsRecord.stagnationWarnings)
          : 0;
        const forcedFinishFromStagnation = Number.isFinite(statsRecord.forcedFinishFromStagnation) && Number(statsRecord.forcedFinishFromStagnation) >= 0
          ? Number(statsRecord.forcedFinishFromStagnation)
          : 0;
        const promptInsertedTokens = Number.isFinite(statsRecord.promptInsertedTokens) && Number(statsRecord.promptInsertedTokens) >= 0
          ? Number(statsRecord.promptInsertedTokens)
          : 0;
        const rawToolResultTokens = Number.isFinite(statsRecord.rawToolResultTokens) && Number(statsRecord.rawToolResultTokens) >= 0
          ? Number(statsRecord.rawToolResultTokens)
          : 0;
        const newEvidenceCalls = Number.isFinite(statsRecord.newEvidenceCalls) && Number(statsRecord.newEvidenceCalls) >= 0
          ? Number(statsRecord.newEvidenceCalls)
          : 0;
        const noNewEvidenceCalls = Number.isFinite(statsRecord.noNewEvidenceCalls) && Number(statsRecord.noNewEvidenceCalls) >= 0
          ? Number(statsRecord.noNewEvidenceCalls)
          : 0;
        if (
          calls <= 0 && outputCharsTotal <= 0 && outputTokensTotal <= 0 && outputTokensEstimatedCount <= 0
          && lineReadCalls <= 0 && lineReadLinesTotal <= 0 && lineReadTokensTotal <= 0
          && finishRejections <= 0 && semanticRepeatRejects <= 0 && stagnationWarnings <= 0
          && forcedFinishFromStagnation <= 0 && promptInsertedTokens <= 0 && rawToolResultTokens <= 0
          && newEvidenceCalls <= 0 && noNewEvidenceCalls <= 0
        ) {
          continue;
        }
        normalizedToolStats[toolType] = {
          ...createEmptyToolTypeStats(),
          calls,
          outputCharsTotal,
          outputTokensTotal,
          outputTokensEstimatedCount,
          lineReadCalls,
          lineReadLinesTotal,
          lineReadTokensTotal,
          finishRejections,
          semanticRepeatRejects,
          stagnationWarnings,
          forcedFinishFromStagnation,
          promptInsertedTokens,
          rawToolResultTokens,
          newEvidenceCalls,
          noNewEvidenceCalls,
        };
      }
      metadata.toolStats = Object.keys(normalizedToolStats).length > 0 ? normalizedToolStats : null;
    }
    if (Number.isFinite(parsed.promptCacheTokens) && Number(parsed.promptCacheTokens) >= 0) {
      metadata.promptCacheTokens = Number(parsed.promptCacheTokens);
    }
    if (Number.isFinite(parsed.promptEvalTokens) && Number(parsed.promptEvalTokens) >= 0) {
      metadata.promptEvalTokens = Number(parsed.promptEvalTokens);
    }
    if (Number.isFinite(parsed.speculativeAcceptedTokens) && Number(parsed.speculativeAcceptedTokens) >= 0) {
      metadata.speculativeAcceptedTokens = Number(parsed.speculativeAcceptedTokens);
    }
    if (Number.isFinite(parsed.speculativeGeneratedTokens) && Number(parsed.speculativeGeneratedTokens) >= 0) {
      metadata.speculativeGeneratedTokens = Number(parsed.speculativeGeneratedTokens);
    }
    if (Number.isFinite(parsed.requestDurationMs) && Number(parsed.requestDurationMs) >= 0) {
      metadata.requestDurationMs = Number(parsed.requestDurationMs);
    }
    if (
      parsed.artifactType === 'summary_request'
      || parsed.artifactType === 'planner_debug'
      || parsed.artifactType === 'planner_failed'
    ) {
      metadata.artifactType = parsed.artifactType;
    }
    if (typeof parsed.artifactRequestId === 'string' && parsed.artifactRequestId.trim()) {
      metadata.artifactRequestId = parsed.artifactRequestId.trim();
    }
    if (
      parsed.artifactPayload
      && typeof parsed.artifactPayload === 'object'
      && !Array.isArray(parsed.artifactPayload)
    ) {
      metadata.artifactPayload = parsed.artifactPayload as Dict;
    }
  } catch {
    return metadata;
  }
  return metadata;
}
