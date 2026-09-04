import { z } from '../../lib/zod.js';
import { JsonValueSchema } from '../../lib/json-types.js';
import { StreamStopSchema } from '../../llm-protocol/types.js';
import { RejectionKindSchema } from '../engine/task-loop-support.js';

/** Newest turns are kept; older ones age out so the file stays small enough to rewrite constantly. */
export const LIVE_SNAPSHOT_MAX_TURNS = 100;
export const LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS = 300;
export const LIVE_SNAPSHOT_COMMAND_CHARS = 500;

// ---------------------------------------------------------------------------
// Snapshot document
// ---------------------------------------------------------------------------

export const LiveRunPhaseNameSchema = z.enum([
  'starting',
  'prompt_preflight',
  'model_request',
  'tool_execute',
  'idle',
  'done',
]);

export const LiveRunPhaseSchema = z.object({
  name: LiveRunPhaseNameSchema,
  turn: z.number().nullable(),
  startedAtUtc: z.string(),
  elapsedMs: z.number(),
  detail: z.string().nullable(),
});

export const LiveRunProviderRequestSchema = z.object({
  stage: z.string(),
  startedAtUtc: z.string(),
  elapsedMs: z.number().nullable(),
  statusCode: z.number().nullable(),
  error: z.string().nullable(),
});

export const LiveRunToolSchema = z.object({
  toolName: z.string(),
  command: z.string(),
  startedAtUtc: z.string(),
  durationMs: z.number().nullable(),
  exitCode: z.number().nullable(),
  outputChars: z.number().nullable(),
  outputTokens: z.number().nullable(),
  outputHead: z.string(),
  outputTail: z.string(),
});

export const LiveRunApprovalSchema = z.object({
  verdict: z.string(),
  reason: z.string(),
});

export const LiveRunTurnSchema = z.object({
  turn: z.number(),
  promptChars: z.number().nullable(),
  promptTokens: z.number().nullable(),
  tokenizeMs: z.number().nullable(),
  tokenSource: z.string().nullable(),
  maxPromptBudget: z.number().nullable(),
  overflowTokens: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  modelDurationMs: z.number().nullable(),
  promptEvalTokens: z.number().nullable(),
  promptCacheTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  thinkingTokens: z.number().nullable(),
  stop: StreamStopSchema.nullable(),
  providerRequests: z.array(LiveRunProviderRequestSchema),
  approval: LiveRunApprovalSchema.nullable(),
  tool: LiveRunToolSchema.nullable(),
});

export const LiveRunSnapshotSchema = z.object({
  requestId: z.string(),
  taskKind: z.string(),
  pid: z.number(),
  repoRoot: z.string(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  startedAtUtc: z.string(),
  snapshotAtUtc: z.string(),
  elapsedMs: z.number(),
  phase: LiveRunPhaseSchema,
  turnsRecorded: z.number(),
  turns: z.array(LiveRunTurnSchema),
  totals: z.object({
    modelMs: z.number(),
    toolMs: z.number(),
    promptEvalTokens: z.number(),
    promptCacheTokens: z.number(),
    completionTokens: z.number(),
    toolOutputChars: z.number(),
  }),
  slowest: z.object({
    byModelMs: z.array(z.object({ turn: z.number(), ms: z.number() })),
    byToolMs: z.array(z.object({ turn: z.number(), ms: z.number() })),
  }),
  counters: z.object({
    turns: z.number(),
    providerRequests: z.number(),
    providerErrors: z.number(),
    rejectedCalls: z.number(),
    nonZeroExits: z.number(),
    safetyRejects: z.number(),
    approvalDenials: z.number(),
  }),
  health: z.object({
    lastError: z.string().nullable(),
    lastSnapshotWriteError: z.string().nullable(),
    finishReason: z.string().nullable(),
  }),
});

export type LiveRunSnapshot = z.infer<typeof LiveRunSnapshotSchema>;
export type LiveRunTurn = z.infer<typeof LiveRunTurnSchema>;
export type LiveRunPhaseName = z.infer<typeof LiveRunPhaseNameSchema>;

// ---------------------------------------------------------------------------
// Logger event inputs (subset extraction; unknown keys are dropped by zod)
// ---------------------------------------------------------------------------

const OptionalNumber = z.number().nullable().optional();
const OptionalString = z.string().nullable().optional();

export const LoggerEventKindSchema = z.object({ kind: z.string() });

export const RunStartEventSchema = z.object({
  configuredModel: OptionalString,
  baseUrl: OptionalString,
});

export const TurnPreflightStartEventSchema = z.object({
  turn: z.number(),
  promptChars: OptionalNumber,
});

export const TurnPreflightBudgetEventSchema = z.object({
  turn: z.number(),
  promptTokenCount: OptionalNumber,
  tokenizeElapsedMs: OptionalNumber,
  tokenCountSource: OptionalString,
  maxPromptBudget: OptionalNumber,
  overflowTokens: OptionalNumber,
  maxOutputTokens: OptionalNumber,
});

export const TurnModelRequestEventSchema = z.object({ turn: z.number() });

export const ProviderRequestStartEventSchema = z.object({ stage: z.string() });

export const ProviderRequestDoneEventSchema = z.object({
  stage: z.string(),
  statusCode: OptionalNumber,
  elapsedMs: OptionalNumber,
});

export const ProviderRequestErrorEventSchema = z.object({
  stage: z.string(),
  elapsedMs: OptionalNumber,
  error: JsonValueSchema.optional(),
});

export const TurnModelResponseEventSchema = z.object({
  turn: z.number(),
  promptTokens: OptionalNumber,
  completionTokens: OptionalNumber,
  thinkingTokens: OptionalNumber,
  promptCacheTokens: OptionalNumber,
  promptEvalTokens: OptionalNumber,
  stop: StreamStopSchema,
});

export const TurnCommandStartEventSchema = z.object({
  turn: z.number(),
  toolName: z.string(),
  commandToRun: z.string(),
});

const CommandResultBaseSchema = z.object({
  turn: z.number(),
  command: z.string(),
  toolName: OptionalString,
  output: OptionalString,
  resultTokenCount: OptionalNumber,
});

/**
 * A tool outcome is either executed or rejected, and the exit code says which: a rejection never
 * ran, so it has none. Keeping the two shapes distinct is what makes a rejection that forgets to
 * name its kind fail to parse instead of quietly counting toward nothing.
 */
export const RejectedCommandResultSchema = CommandResultBaseSchema.extend({
  exitCode: z.null(),
  rejectionKind: RejectionKindSchema,
  rejectionReason: OptionalString,
});

export const ExecutedCommandResultSchema = CommandResultBaseSchema.extend({
  exitCode: z.number(),
});

export const TurnCommandResultEventSchema = z.union([
  RejectedCommandResultSchema,
  ExecutedCommandResultSchema,
]);

export const ApprovalVerdictEventSchema = z.object({
  turn: z.number(),
  verdict: z.string(),
  reason: z.string(),
});

export const TaskDoneEventSchema = z.object({ reason: OptionalString });
