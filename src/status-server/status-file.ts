import * as fs from 'node:fs';
import type { Dict } from '../lib/types.js';
import { writeText } from './http-utils.js';

export const STATUS_TRUE = 'true';
export const STATUS_FALSE = 'false';
export const STATUS_LOCK_REQUESTED = 'lock_requested';
export const STATUS_FOREIGN_LOCK = 'foreign_lock';

export function normalizeStatusText(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === STATUS_TRUE ||
    normalized === STATUS_FALSE ||
    normalized === STATUS_LOCK_REQUESTED ||
    normalized === STATUS_FOREIGN_LOCK
  ) {
    return normalized;
  }
  return STATUS_FALSE;
}

export function ensureStatusFile(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    writeText(targetPath, STATUS_FALSE);
  }
}

export function readStatusText(targetPath: string): string {
  try {
    return normalizeStatusText(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return STATUS_FALSE;
  }
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
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  requestDurationMs: number | null;
  artifactType: string | null;
  artifactRequestId: string | null;
  artifactPayload: Dict | null;
  totalOutputTokens?: number | null;
};

export function parseStatusMetadata(bodyText: string): StatusMetadata {
  const metadata: StatusMetadata = {
    requestId: null,
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
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
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
    if (Number.isFinite(parsed.thinkingTokens) && Number(parsed.thinkingTokens) >= 0) {
      metadata.thinkingTokens = Number(parsed.thinkingTokens);
    }
    if (Number.isFinite(parsed.promptCacheTokens) && Number(parsed.promptCacheTokens) >= 0) {
      metadata.promptCacheTokens = Number(parsed.promptCacheTokens);
    }
    if (Number.isFinite(parsed.promptEvalTokens) && Number(parsed.promptEvalTokens) >= 0) {
      metadata.promptEvalTokens = Number(parsed.promptEvalTokens);
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
