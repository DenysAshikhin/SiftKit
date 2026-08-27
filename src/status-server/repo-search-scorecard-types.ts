import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { OptionalJsonValue } from '../lib/json-types.js';
import { ImageDataUrlSchema, ImageMetadataSchema, ToolActivityKindSchema, ToolActivitySubjectSchema } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { ChatGroundingStatusSchema, type ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';

export const RepoSearchCommandResultSchema = z.strictObject({
  turn: z.number().int().nonnegative().nullable(),
  command: z.string(),
  activityKind: ToolActivityKindSchema,
  activitySubject: ToolActivitySubjectSchema,
  displayCommand: z.string(),
  output: z.string(),
  outputSnippet: z.string(),
  exitCode: z.number().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  outputTokensEstimated: z.boolean(),
  promptTokenCount: z.number().int().nonnegative().nullable(),
  imageDataUrls: z.array(ImageDataUrlSchema),
  imageMeta: z.array(ImageMetadataSchema),
});
export type RepoSearchCommandResult = z.infer<typeof RepoSearchCommandResultSchema>;

const TurnThinkingSchema = z.record(z.string(), z.string());

export const RepoSearchTaskResultSchema = z.strictObject({
  finalOutput: z.string(),
  /** Raw summary text from the run's last compaction; empty when the run never compacted. */
  compactionSummary: z.string(),
  turnsUsed: z.number().int().nonnegative().nullable(),
  groundingStatus: ChatGroundingStatusSchema.nullable(),
  commands: z.array(RepoSearchCommandResultSchema),
  turnThinking: TurnThinkingSchema,
  missingSignals: z.array(z.string()),
});
export type RepoSearchTaskResult = z.infer<typeof RepoSearchTaskResultSchema>;

export const RepoSearchTotalsSchema = z.strictObject({
  promptTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  thinkingTokens: z.number().nonnegative().nullable(),
  promptCacheTokens: z.number().nonnegative().nullable(),
  promptEvalTokens: z.number().nonnegative().nullable(),
  promptEvalDurationMs: z.number().nonnegative().nullable(),
  generationDurationMs: z.number().nonnegative().nullable(),
  speculativeAcceptedTokens: z.number().nonnegative().nullable(),
  speculativeGeneratedTokens: z.number().nonnegative().nullable(),
  outputTokensEstimatedCount: z.number().nonnegative().nullable(),
  thinkingTokensEstimatedCount: z.number().nonnegative().nullable(),
});
export type RepoSearchTotals = z.infer<typeof RepoSearchTotalsSchema>;

export const RepoSearchScorecardSchema = z.strictObject({
  totals: RepoSearchTotalsSchema,
  tasks: z.array(RepoSearchTaskResultSchema),
});
export type RepoSearchScorecard = z.infer<typeof RepoSearchScorecardSchema>;

export const RepoSearchResultSchema = z.strictObject({
  requestId: z.string(),
  transcriptPath: z.string(),
  artifactPath: z.string(),
  scorecard: RepoSearchScorecardSchema,
});
export type RepoSearchResult = z.infer<typeof RepoSearchResultSchema>;

function normalizeGroundingStatus(value: OptionalJsonValue): ChatGroundingStatus | null {
  return value === 'ungrounded' || value === 'snippet_only' || value === 'fetched' ? value : null;
}

function readNullableNumber(reader: JsonRecordReader, key: string): number | null {
  return reader.nullableNonNegativeNumber(key);
}

function normalizeCommand(value: OptionalJsonValue): RepoSearchCommandResult {
  const reader = JsonRecordReader.fromJsonValue(value);
  const imageDataUrlsValue = reader.value('imageDataUrls');
  const imageMetaValue = reader.value('imageMeta');
  return RepoSearchCommandResultSchema.parse({
    turn: reader.nullableNonNegativeInteger('turn'),
    command: reader.string('command'),
    activityKind: ToolActivityKindSchema.parse(reader.value('activityKind')),
    activitySubject: ToolActivitySubjectSchema.parse(reader.value('activitySubject')),
    displayCommand: reader.string('displayCommand') || reader.string('modelVisibleCommand'),
    output: reader.string('promptOutput') || reader.string('output'),
    outputSnippet: reader.string('outputSnippet'),
    exitCode: reader.number('exitCode'),
    outputTokens: reader.nullableNonNegativeInteger('outputTokens'),
    outputTokensEstimated: reader.value('outputTokensEstimated') !== false,
    promptTokenCount: reader.nullableNonNegativeInteger('promptTokenCount'),
    imageDataUrls: imageDataUrlsValue === undefined
      ? []
      : z.array(ImageDataUrlSchema).parse(imageDataUrlsValue),
    imageMeta: imageMetaValue === undefined
      ? []
      : z.array(ImageMetadataSchema).parse(imageMetaValue),
  });
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
  return RepoSearchTaskResultSchema.parse({
    finalOutput: reader.string('finalOutput'),
    compactionSummary: reader.string('compactionSummary'),
    turnsUsed: reader.nullableNonNegativeInteger('turnsUsed'),
    groundingStatus: normalizeGroundingStatus(reader.value('groundingStatus')),
    commands: Array.isArray(commandsRaw) ? commandsRaw.map((entry) => normalizeCommand(entry)) : [],
    turnThinking,
    missingSignals: Array.isArray(missingSignalsRaw)
      ? missingSignalsRaw.map((entry) => String(entry)).filter((entry) => entry.length > 0)
      : [],
  });
}

function normalizeTotals(value: OptionalJsonValue): RepoSearchTotals {
  const reader = JsonRecordReader.fromJsonValue(value);
  return RepoSearchTotalsSchema.parse({
    promptTokens: readNullableNumber(reader, 'promptTokens'),
    outputTokens: readNullableNumber(reader, 'outputTokens'),
    thinkingTokens: readNullableNumber(reader, 'thinkingTokens'),
    promptCacheTokens: readNullableNumber(reader, 'promptCacheTokens'),
    promptEvalTokens: readNullableNumber(reader, 'promptEvalTokens'),
    promptEvalDurationMs: readNullableNumber(reader, 'promptEvalDurationMs'),
    generationDurationMs: readNullableNumber(reader, 'generationDurationMs'),
    speculativeAcceptedTokens: readNullableNumber(reader, 'speculativeAcceptedTokens'),
    speculativeGeneratedTokens: readNullableNumber(reader, 'speculativeGeneratedTokens'),
    outputTokensEstimatedCount: readNullableNumber(reader, 'outputTokensEstimatedCount'),
    thinkingTokensEstimatedCount: readNullableNumber(reader, 'thinkingTokensEstimatedCount'),
  });
}

export function normalizeRepoSearchScorecard(value: OptionalJsonValue): RepoSearchScorecard {
  const reader = JsonRecordReader.fromJsonValue(value);
  const tasksRaw = reader.value('tasks');
  return RepoSearchScorecardSchema.parse({
    totals: normalizeTotals(reader.value('totals')),
    tasks: Array.isArray(tasksRaw) ? tasksRaw.map((entry) => normalizeTask(entry)) : [],
  });
}

export function normalizeRepoSearchResult(value: OptionalJsonValue): RepoSearchResult {
  const reader = JsonRecordReader.fromJsonValue(value);
  return RepoSearchResultSchema.parse({
    requestId: reader.string('requestId'),
    transcriptPath: reader.string('transcriptPath'),
    artifactPath: reader.string('artifactPath'),
    scorecard: normalizeRepoSearchScorecard(reader.value('scorecard')),
  });
}

export function getRepoSearchTasks(scorecard: RepoSearchScorecard): RepoSearchTaskResult[] {
  return scorecard.tasks;
}

export function getRepoSearchTotals(scorecard: RepoSearchScorecard): RepoSearchTotals {
  return scorecard.totals;
}
