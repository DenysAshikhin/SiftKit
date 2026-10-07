import { buildIgnorePolicy } from '../../src/repo-search/command-safety.ts';
import { ChatGroundingPolicy } from '../../src/repo-search/chat-grounding-policy.ts';
import type { TaskCommand } from '../../src/repo-search/prompts.ts';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.ts';
import type { RepoSearchMockCommandResult } from '../../src/repo-search/types.ts';
import { DuplicateTracker } from '../../src/repo-search/engine/duplicate-tracker.ts';
import { ForcedFinishController } from '../../src/repo-search/engine/forced-finish.ts';
import { ProgressReporter } from '../../src/repo-search/engine/progress-reporter.ts';
import { ReadWindowGovernor } from '../../src/repo-search/engine/read-window-governor.ts';
import { TokenUsageTracker } from '../../src/repo-search/engine/token-usage.ts';
import { ToolActionProcessor } from '../../src/repo-search/engine/tool-action-processor.ts';
import type { ApprovalRequester } from '../../src/repo-search/engine/approval-gate.ts';
import type { ChatRunEvidenceRecorder } from '../../src/repo-search/engine/chat-run-evidence.ts';
import type { QuestionGate } from '../../src/repo-search/engine/question-gate.ts';
import { ToolResultBudgeter } from '../../src/repo-search/engine/tool-result-budgeter.ts';
import { ToolStatsRecorder } from '../../src/repo-search/engine/tool-stats.ts';
import { TranscriptManager } from '../../src/repo-search/engine/transcript-manager.ts';
import { TurnBudget } from '../../src/repo-search/engine/turn-budget.ts';
import { SilentProgressWriter } from '../../src/lib/progress-writer.ts';
import { makeMockWebTools } from './mock-web-tools.ts';
import { parseLoggedEvent } from './logged-events.ts';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.ts';
import { makeTestPreset } from './model-presets.ts';
import { RepoSearchRuntimeProfile } from '../../src/repo-search/engine/runtime-profile.ts';
import type { LoopCounters } from '../../src/repo-search/engine/task-loop-support.ts';
import type { RepoSearchTaskKind } from '../../src/repo-search/task-kind.ts';
import { PROMPT_COMPACTION_RESERVE_TOKENS } from '../../src/lib/context-token-budget.ts';

// Shared between the reporter, the budget, and the enforced deps budget — they must agree.
const MAX_TURNS = 5;

export function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
  taskKind: RepoSearchTaskKind = 'repo-search',
  approvalGate: ApprovalRequester | null = null,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | undefined = undefined,
  options: {
    visionEnabled?: boolean;
    visionImageRetention?: number;
    visionMaxImagePixels?: number;
    evidenceRecorder?: ChatRunEvidenceRecorder;
    questionGate?: QuestionGate;
  } = {},
): {
  processor: ToolActionProcessor;
  commands: TaskCommand[];
  counters: LoopCounters;
  tokenUsage: TokenUsageTracker;
  budget: TurnBudget;
  events: JsonObject[];
  transcript: TranscriptManager;
} {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, rejectedCalls: 0, nonZeroExits: 0, safetyRejects: 0, reason: 'max_turns' };
  const tokenUsage = new TokenUsageTracker(undefined, true);
  const budget = new TurnBudget({ compactionReserveTokens: PROMPT_COMPACTION_RESERVE_TOKENS, totalContextTokens: 20000, maxTurns: MAX_TURNS });
  const events: JsonObject[] = [];
  const liveImagePathKeys = new Set<string>();
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'q',
    initialUserImages: [],
    liveImagePathKeys,
    contextRecorder: options.evidenceRecorder,
  });
  const processor = new ToolActionProcessor({
    task: { id: 'task-alignment', question: 'q' },
    repoRoot: root,
    config: undefined,
    mockCommandResults,
    logger: {
      path: 'memory',
      write(event: Record<string, JsonSerializable>): void {
        events.push(parseLoggedEvent(event));
      },
    },
    timingRecorder: null,
    maxInvalidResponses: 3,
    allowedPlannerToolNames,
    approvalGate,
    evidenceRecorder: options.evidenceRecorder ?? null,
    questionGate: options.questionGate ?? null,
    runtimeProfile: new RepoSearchRuntimeProfile(taskKind),
    chatWebGroundingEnabled: false,
    chatWebGroundingPolicy: new ChatGroundingPolicy({ enabled: false }),
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeMockWebTools(),
    budget,
    tokenUsage,
    toolStats: new ToolStatsRecorder(),
    duplicates: new DuplicateTracker(),
    forcedFinish: new ForcedFinishController(),
    resultBudgeter: new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: true, timingRecorder: null }),
    readWindows: new ReadWindowGovernor(),
    maintainPerStepThinking: true,
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter(),
      taskId: 'task-alignment',
      maxTurns: MAX_TURNS,
      taskStartedAt: Date.now(),
    }),
    transcript,
    recentEvidenceKeys: new Set<string>(),
    mutatedPaths: new Set<string>(),
    successfulToolCalls: [],
    commands,
    maxTurns: MAX_TURNS,
    counters,
    visionEnabled: options.visionEnabled ?? false,
    visionImageRetention: options.visionImageRetention ?? 8,
    visionMaxImagePixels: options.visionMaxImagePixels ?? 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys,
  });
  return { processor, commands, counters, tokenUsage, budget, events, transcript };
}
