import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  applyHostLlamaRuntimeSettings,
  getActiveModelPreset,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  loadConfig,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
} from '../src/config/index.js';
import { JsonObjectSchema, type JsonSerializable } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { z } from '../src/lib/zod.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';
import {
  captureExecutingPlannerRequest,
  PLANNER_REASONING_BUDGET_MESSAGE,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
} from '../src/repo-search/planner-protocol.js';
import { preflightPlannerPromptBudget } from '../src/repo-search/prompt-budget.js';
import { renderWirePrompt } from '../src/repo-search/wire-prompt.js';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { PromptPreparer } from '../src/repo-search/engine/prompt-preparer.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import {
  allocateLlamaCppSlotId,
  resolvePlannerThinkingFlags,
} from '../src/repo-search/engine/task-loop-support.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { TranscriptCompactor } from '../src/repo-search/engine/transcript-compactor.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { readRuntimeArtifact, upsertRuntimeTextArtifact } from '../src/state/runtime-artifacts.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../src/web-search/tool-policy.js';

const LIVE_REPLAY_ENABLED = process.env.SIFTKIT_TEST_LIVE_REPO_AGENT_COMPACTION_REPLAY === '1';
const SOURCE_ARTIFACT_ID = 'b3f34f16-ac1a-4a38-a82e-449e578afbe1';
const SOURCE_LAST_COMPLETED_TURN = 78;
const REPLAY_TURN = 79;
const SOURCE_TOTAL_CONTEXT_TOKENS = 155_000;
const SOURCE_PRECOMPACTION_PROMPT_TOKENS = 140_280;
const SOURCE_RECONSTRUCTION_TOKEN_TOLERANCE = 2;
const LIVE_REQUEST_TIMEOUT_MS = 900_000;
const REPLAY_SUMMARY_ARTIFACT_ID = 'live-repo-agent-compaction-replay-summary-latest';
const RUNTIME_DATABASE_PATH = path.resolve('.siftkit/runtime.sqlite');

const CapturedToolCallSchema = z.object({
  id: z.string(),
  type: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const CapturedMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().optional(),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(CapturedToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

const CapturedTurnMessagesSchema = z.object({
  kind: z.literal('turn_new_messages'),
  turn: z.number().int().positive(),
  messages: z.array(CapturedMessageSchema),
});

const CapturedModelResponseSchema = z.object({
  kind: z.literal('turn_model_response'),
  turn: z.literal(SOURCE_LAST_COMPLETED_TURN),
  text: z.string(),
  thinkingText: z.string(),
});

const CapturedCommandResultSchema = z.object({
  kind: z.literal('turn_command_result'),
  turn: z.literal(SOURCE_LAST_COMPLETED_TURN),
  command: z.string(),
  insertedResultText: z.string(),
});

const CapturedPreflightBudgetSchema = z.object({
  kind: z.literal('turn_preflight_budget'),
  turn: z.literal(REPLAY_TURN),
  promptTokenCount: z.number().int().positive(),
});

const CapturedRunStartSchema = z.object({
  kind: z.literal('run_start'),
  configuredModel: z.string(),
  baseUrl: z.string(),
});

const AppliedCompactionSchema = z.object({
  kind: z.literal('turn_preflight_compaction_applied'),
  beforePromptTokenCount: z.number().int().positive(),
  afterPromptTokenCount: z.number().int().positive(),
  maxPromptBudget: z.number().int().positive(),
  summaryTokenCount: z.number().int().positive(),
  summaryGenerationTokenBudget: z.number().int().positive(),
  summaryReasoningTokenBudget: z.number().int().nonnegative(),
  summaryOutputTokenBudget: z.number().int().positive(),
  summarizerElapsedMs: z.number().nonnegative(),
});

function requireSingle<T>(values: T[], label: string): T {
  assert.equal(values.length, 1, `expected one ${label}, received ${values.length}`);
  const value = values[0];
  assert.ok(value);
  return value;
}

function loadReplaySource(): {
  executingMessages: ChatMessage[];
  finalThinkingText: string;
  finalToolResultText: string;
  sourcePromptTokenCount: number;
  configuredModel: string;
  baseUrl: string;
} {
  const artifact = readRuntimeArtifact(SOURCE_ARTIFACT_ID, RUNTIME_DATABASE_PATH);
  assert.ok(artifact?.contentText, `missing source transcript artifact ${SOURCE_ARTIFACT_ID}`);

  const messageBatches = new Map<number, ChatMessage[]>();
  const finalModelResponses: Array<z.infer<typeof CapturedModelResponseSchema>> = [];
  const finalCommandResults: Array<z.infer<typeof CapturedCommandResultSchema>> = [];
  const replayPreflights: Array<z.infer<typeof CapturedPreflightBudgetSchema>> = [];
  const runStarts: Array<z.infer<typeof CapturedRunStartSchema>> = [];
  for (const line of artifact.contentText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = JsonObjectSchema.parse(parseJsonValueText(line));
    if (event.kind === 'turn_new_messages') {
      const parsed = CapturedTurnMessagesSchema.parse(event);
      if (parsed.turn <= SOURCE_LAST_COMPLETED_TURN) {
        assert.equal(messageBatches.has(parsed.turn), false, `duplicate turn_new_messages for turn ${parsed.turn}`);
        messageBatches.set(parsed.turn, parsed.messages);
      }
    } else if (event.kind === 'turn_model_response' && event.turn === SOURCE_LAST_COMPLETED_TURN) {
      finalModelResponses.push(CapturedModelResponseSchema.parse(event));
    } else if (event.kind === 'turn_command_result' && event.turn === SOURCE_LAST_COMPLETED_TURN) {
      finalCommandResults.push(CapturedCommandResultSchema.parse(event));
    } else if (event.kind === 'turn_preflight_budget' && event.turn === REPLAY_TURN) {
      replayPreflights.push(CapturedPreflightBudgetSchema.parse(event));
    } else if (event.kind === 'run_start') {
      runStarts.push(CapturedRunStartSchema.parse(event));
    }
  }

  const executingMessages: ChatMessage[] = [];
  for (let turn = 1; turn <= SOURCE_LAST_COMPLETED_TURN; turn += 1) {
    const batch = messageBatches.get(turn);
    assert.ok(batch, `missing turn_new_messages for turn ${turn}`);
    executingMessages.push(...batch);
  }
  assert.equal(messageBatches.size, SOURCE_LAST_COMPLETED_TURN);
  assert.equal(executingMessages[0]?.role, 'system');
  assert.equal(executingMessages[1]?.role, 'user');
  assert.equal(executingMessages.at(-1)?.role, 'tool');

  const finalModelResponse = requireSingle(finalModelResponses, 'turn-78 model response');
  const finalCommandResult = requireSingle(finalCommandResults, 'turn-78 command result');
  const replayPreflight = requireSingle(replayPreflights, 'turn-79 preflight');
  const runStart = requireSingle(runStarts, 'run_start');
  assert.equal(finalModelResponse.text, '');
  assert.equal(finalCommandResult.command, 'ls path="tests/helpers" limit=10');
  assert.equal(replayPreflight.promptTokenCount, SOURCE_PRECOMPACTION_PROMPT_TOKENS);

  return {
    executingMessages,
    finalThinkingText: finalModelResponse.thinkingText,
    finalToolResultText: finalCommandResult.insertedResultText,
    sourcePromptTokenCount: replayPreflight.promptTokenCount,
    configuredModel: runStart.configuredModel,
    baseUrl: runStart.baseUrl,
  };
}

test('approximate historical replay compacts the failed repo-agent turn and resumes its planner request', {
  timeout: LIVE_REQUEST_TIMEOUT_MS * 2,
  skip: LIVE_REPLAY_ENABLED
    ? false
    : 'set SIFTKIT_TEST_LIVE_REPO_AGENT_COMPACTION_REPLAY=1 after receiving explicit approval',
}, async () => {
  const source = loadReplaySource();
  const config = await applyHostLlamaRuntimeSettings(await loadConfig({ ensure: true }));
  const totalContextTokens = getConfiguredLlamaNumCtx(config);
  assert.equal(totalContextTokens, SOURCE_TOTAL_CONTEXT_TOKENS);

  const model = getConfiguredModel(config);
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  assert.equal(model, source.configuredModel, 'configured model no longer matches the captured run');
  assert.equal(baseUrl, source.baseUrl, 'configured base URL no longer matches the captured run');
  const thinking = resolvePlannerThinkingFlags(config);
  const activePreset = getActiveModelPreset(config);
  const webToolPolicy = resolveWebToolPolicy(config.WebSearch, undefined);
  const plannerTools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(
    applyWebToolPolicy([...INTERACTIVE_REPO_TOOL_NAMES], webToolPolicy),
    activePreset.VisionEnabled === true,
  ));
  const slotId = allocateLlamaCppSlotId(config);
  const executing = captureExecutingPlannerRequest(
    serializeProtocolMessages(source.executingMessages, thinking.reasoningContentEnabled),
    thinking,
    plannerTools,
    slotId,
    1_000,
  );
  const transcript = new TranscriptManager({
    systemPromptContent: 'placeholder',
    historyMessages: [],
    initialUserContent: 'placeholder',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  transcript.replaceWith(source.executingMessages, null);
  // The source artifact predates persistence of provider tool-call IDs. `call_0` is the
  // streaming client's deterministic fallback for the first native tool call; the live
  // pre-compaction token assertion below rejects the replay if this reconstruction differs.
  transcript.appendToolExchange(
    { toolName: 'ls', args: { path: 'tests/helpers', limit: 10 } },
    'call_0',
    source.finalToolResultText,
    source.finalThinkingText,
  );
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 100 });
  const replayPreflight = await preflightPlannerPromptBudget({
    config,
    prompt: renderWirePrompt({
      messages: transcript.getMessages(),
      tools: plannerTools,
      includeReasoningContent: thinking.reasoningContentEnabled,
    }),
    maxPromptTokens: budget.maxPromptTokens,
  });
  assert.ok(
    Math.abs(replayPreflight.promptTokenCount - source.sourcePromptTokenCount)
      <= SOURCE_RECONSTRUCTION_TOKEN_TOLERANCE,
  );
  assert.equal(replayPreflight.ok, false);

  const events: Array<Record<string, JsonSerializable>> = [];
  const logger = {
    path: 'memory',
    write(event: Record<string, JsonSerializable>): void {
      events.push(event);
    },
  };
  const preparer = new PromptPreparer({
    taskId: 'live-repo-agent-compaction-replay',
    config,
    useEstimatedTokensOnly: false,
    budget,
    plannerTools,
    thinking,
    transcript,
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'),
    compactor: new TranscriptCompactor({
      config,
      baseUrl,
      model,
      timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
      totalContextTokens,
      compactionReserveTokens: budget.compactionReserveTokens,
      useEstimatedTokensOnly: false,
      mockResponses: undefined,
      tokenUsage: new TokenUsageTracker(config, false),
      logger,
      abortSignal: undefined,
    }),
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      taskId: 'live-repo-agent-compaction-replay',
      maxTurns: 100,
      taskStartedAt: Date.now(),
    }),
    logger,
    timingRecorder: null,
  });

  const prepared = await preparer.prepareTurn(REPLAY_TURN, 0, {
    kind: 'planner',
    executing,
  });

  const compaction = AppliedCompactionSchema.parse(
    events.find((event) => event.kind === 'turn_preflight_compaction_applied'),
  );
  assert.equal(source.sourcePromptTokenCount, SOURCE_PRECOMPACTION_PROMPT_TOKENS);
  assert.equal(compaction.beforePromptTokenCount, replayPreflight.promptTokenCount);
  assert.ok(Number(compaction.afterPromptTokenCount) <= Number(compaction.maxPromptBudget));
  assert.ok(prepared.kind === 'ready');
  const summaryText = prepared.compactionSummary?.trim();
  assert.ok(summaryText);
  const artifactContent = [
    '# Live repo-agent compaction replay summary',
    '',
    `- Saved: ${new Date().toISOString()}`,
    `- Source artifact: ${SOURCE_ARTIFACT_ID}`,
    `- Source pre-compaction prompt tokens: ${source.sourcePromptTokenCount}`,
    `- Reconstructed pre-compaction prompt tokens: ${replayPreflight.promptTokenCount}`,
    `- Post-compaction prompt tokens: ${compaction.afterPromptTokenCount}`,
    `- Maximum prompt budget: ${compaction.maxPromptBudget}`,
    `- Summary tokens: ${compaction.summaryTokenCount}`,
    `- Generation budget: ${compaction.summaryGenerationTokenBudget}`,
    `- Thinking cap: ${compaction.summaryReasoningTokenBudget}`,
    `- Output cap: ${compaction.summaryOutputTokenBudget}`,
    `- Summarizer elapsed milliseconds: ${compaction.summarizerElapsedMs}`,
    '',
    '## Summary',
    '',
    summaryText,
    '',
  ].join('\n');
  const savedArtifact = upsertRuntimeTextArtifact({
    id: REPLAY_SUMMARY_ARTIFACT_ID,
    artifactKind: 'live_repo_agent_compaction_replay_summary',
    requestId: 'live-repo-agent-compaction-replay',
    title: 'Latest live repo-agent compaction replay summary',
    content: artifactContent,
    databasePath: RUNTIME_DATABASE_PATH,
  });
  assert.equal(
    readRuntimeArtifact(savedArtifact.id, RUNTIME_DATABASE_PATH)?.contentText,
    artifactContent,
  );
  process.stdout.write(`Saved compaction summary: ${savedArtifact.uri}\n`);

  const presetBudgetMessageCustomized = Boolean(activePreset.ReasoningBudgetMessage)
    && activePreset.ReasoningBudgetMessage !== SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE;
  const reasoningBudgetMessage = presetBudgetMessageCustomized
    ? null
    : PLANNER_REASONING_BUDGET_MESSAGE;

  const response = await requestRepoSearchPlannerProtocolAction({
    config,
    baseUrl,
    model,
    messages: serializeProtocolMessages(transcript.getMessages(), thinking.reasoningContentEnabled),
    slotId,
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
    maxTokens: prepared.maxOutputTokens,
    ...thinking,
    ...(reasoningBudgetMessage === null ? {} : { reasoningBudgetMessage }),
    stage: 'planner_action',
    tools: plannerTools,
    responseSchema: null,
    logger: null,
  });

  assert.equal(response.mockExhausted, false);
  assert.ok(response.rawText.trim() || response.toolCalls.length > 0);
});
