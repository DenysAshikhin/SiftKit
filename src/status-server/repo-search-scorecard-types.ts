import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { OptionalJsonValue } from '../lib/json-types.js';
import type { ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';

export type RepoSearchCommandResult = {
  turn: number | null;
  command: string;
  displayCommand: string;
  output: string;
  outputSnippet: string;
  exitCode: number | null;
  outputTokens: number | null;
  outputTokensEstimated: boolean;
};

export type RepoSearchTaskResult = {
  finalOutput: string;
  turnsUsed: number | null;
  groundingStatus: ChatGroundingStatus | null;
  commands: RepoSearchCommandResult[];
  turnThinking: { readonly [turn: string]: string };
  missingSignals: string[];
};

export type RepoSearchTotals = {
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  outputTokensEstimatedCount: number | null;
  thinkingTokensEstimatedCount: number | null;
};

export type RepoSearchScorecard = {
  totals: RepoSearchTotals;
  tasks: RepoSearchTaskResult[];
};

export type RepoSearchResult = {
  requestId: string;
  transcriptPath: string;
  artifactPath: string;
  scorecard: RepoSearchScorecard;
};

function normalizeGroundingStatus(value: OptionalJsonValue): ChatGroundingStatus | null {
  return value === 'ungrounded' || value === 'snippet_only' || value === 'fetched' ? value : null;
}

function readNullableNumber(reader: JsonRecordReader, key: string): number | null {
  return reader.nullableNonNegativeNumber(key);
}

function normalizeCommand(value: OptionalJsonValue): RepoSearchCommandResult {
  const reader = JsonRecordReader.fromJsonValue(value);
  return {
    turn: reader.nullableNonNegativeInteger('turn'),
    command: reader.string('command'),
    displayCommand: reader.string('displayCommand') || reader.string('modelVisibleCommand'),
    output: reader.string('promptOutput') || reader.string('output'),
    outputSnippet: reader.string('outputSnippet'),
    exitCode: reader.number('exitCode'),
    outputTokens: reader.nullableNonNegativeInteger('outputTokens'),
    outputTokensEstimated: reader.value('outputTokensEstimated') !== false,
  };
}

function normalizeTask(value: OptionalJsonValue): RepoSearchTaskResult {
  const reader = JsonRecordReader.fromJsonValue(value);
  const commandsRaw = reader.value('commands');
  const missingSignalsRaw = reader.value('missingSignals');
  const turnThinkingRaw = reader.object('turnThinking') || {};
  const turnThinking: { [turn: string]: string } = {};
  for (const [turn, thinking] of Object.entries(turnThinkingRaw)) {
    if (typeof thinking === 'string') {
      turnThinking[turn] = thinking;
    }
  }
  return {
    finalOutput: reader.string('finalOutput'),
    turnsUsed: reader.nullableNonNegativeInteger('turnsUsed'),
    groundingStatus: normalizeGroundingStatus(reader.value('groundingStatus')),
    commands: Array.isArray(commandsRaw) ? commandsRaw.map((entry) => normalizeCommand(entry)) : [],
    turnThinking,
    missingSignals: Array.isArray(missingSignalsRaw)
      ? missingSignalsRaw.map((entry) => String(entry)).filter((entry) => entry.length > 0)
      : [],
  };
}

function normalizeTotals(value: OptionalJsonValue): RepoSearchTotals {
  const reader = JsonRecordReader.fromJsonValue(value);
  return {
    promptTokens: readNullableNumber(reader, 'promptTokens'),
    outputTokens: readNullableNumber(reader, 'outputTokens'),
    thinkingTokens: readNullableNumber(reader, 'thinkingTokens'),
    promptCacheTokens: readNullableNumber(reader, 'promptCacheTokens'),
    promptEvalTokens: readNullableNumber(reader, 'promptEvalTokens'),
    promptEvalDurationMs: readNullableNumber(reader, 'promptEvalDurationMs'),
    generationDurationMs: readNullableNumber(reader, 'generationDurationMs'),
    outputTokensEstimatedCount: readNullableNumber(reader, 'outputTokensEstimatedCount'),
    thinkingTokensEstimatedCount: readNullableNumber(reader, 'thinkingTokensEstimatedCount'),
  };
}

export function normalizeRepoSearchScorecard(value: OptionalJsonValue): RepoSearchScorecard {
  const reader = JsonRecordReader.fromJsonValue(value);
  const tasksRaw = reader.value('tasks');
  return {
    totals: normalizeTotals(reader.value('totals')),
    tasks: Array.isArray(tasksRaw) ? tasksRaw.map((entry) => normalizeTask(entry)) : [],
  };
}

export function normalizeRepoSearchResult(value: OptionalJsonValue): RepoSearchResult {
  const reader = JsonRecordReader.fromJsonValue(value);
  return {
    requestId: reader.string('requestId'),
    transcriptPath: reader.string('transcriptPath'),
    artifactPath: reader.string('artifactPath'),
    scorecard: normalizeRepoSearchScorecard(reader.value('scorecard')),
  };
}

export function getRepoSearchTasks(scorecard: RepoSearchScorecard): RepoSearchTaskResult[] {
  return scorecard.tasks;
}

export function getRepoSearchTotals(scorecard: RepoSearchScorecard): RepoSearchTotals {
  return scorecard.totals;
}
