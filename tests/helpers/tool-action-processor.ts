import { buildIgnorePolicy } from '../../src/repo-search/command-safety.js';
import { ChatGroundingPolicy } from '../../src/repo-search/chat-grounding-policy.js';
import type { TaskCommand } from '../../src/repo-search/prompts.js';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.js';
import type { RepoSearchMockCommandResult } from '../../src/repo-search/types.js';
import { DuplicateTracker } from '../../src/repo-search/engine/duplicate-tracker.js';
import { ForcedFinishController } from '../../src/repo-search/engine/forced-finish.js';
import { ProgressReporter } from '../../src/repo-search/engine/progress-reporter.js';
import { ReadWindowGovernor } from '../../src/repo-search/engine/read-window-governor.js';
import { TokenUsageTracker } from '../../src/repo-search/engine/token-usage.js';
import { ToolActionProcessor } from '../../src/repo-search/engine/tool-action-processor.js';
import type { ApprovalRequester } from '../../src/repo-search/engine/approval-gate.js';
import { ToolResultBudgeter } from '../../src/repo-search/engine/tool-result-budgeter.js';
import { ToolStatsRecorder } from '../../src/repo-search/engine/tool-stats.js';
import { TranscriptManager } from '../../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../../src/repo-search/engine/turn-budget.js';
import { SilentProgressWriter } from '../../src/lib/progress-writer.js';
import { makeMockWebTools } from './mock-web-tools.js';
import { parseLoggedEvent } from './logged-events.js';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.js';
import { makeTestPreset } from './model-presets.js';
import { RepoSearchRuntimeProfile } from '../../src/repo-search/engine/runtime-profile.js';
import type { LoopCounters } from '../../src/repo-search/engine/task-loop-support.js';
import type { RepoSearchTaskKind } from '../../src/repo-search/task-kind.js';

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
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: 'max_turns' };
  const tokenUsage = new TokenUsageTracker(undefined, true);
  const budget = new TurnBudget({ totalContextTokens: 20000, maxTurns: 5, config: null });
  const events: JsonObject[] = [];
  const liveImagePathKeys = new Set<string>();
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'q',
    initialUserImages: [],
    liveImagePathKeys,
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
      maxTurns: 5,
      toolCallLimit: 5,
      taskStartedAt: Date.now(),
    }),
    transcript,
    recentEvidenceKeys: new Set<string>(),
    mutatedPaths: new Set<string>(),
    successfulToolCalls: [],
    commands,
    counters,
    visionEnabled: options.visionEnabled ?? false,
    visionImageRetention: options.visionImageRetention ?? 8,
    visionMaxImagePixels: options.visionMaxImagePixels ?? 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys,
  });
  return { processor, commands, counters, tokenUsage, budget, events, transcript };
}
