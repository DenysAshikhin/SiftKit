import { randomUUID } from 'node:crypto';
import {
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getConfiguredModel,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import { spawnPowerShellAsync } from '../lib/powershell.js';
import { colorize } from '../lib/text-format.js';
import { countLlamaCppTokens, listLlamaCppModels } from '../providers/llama-cpp.js';
import {
  buildIgnorePolicy,
  evaluateCommandSafety,
  isSearchNoMatchExit,
  normalizePlannerCommand,
} from './command-safety.js';
import {
  buildRepoSearchAssistantToolMessage,
  isTransientProviderError,
  parsePlannerAction,
  renderTaskTranscript,
  requestPlannerAction,
  requestTerminalSynthesis,
  type ChatMessage,
  type PlannerActionResponse,
} from './planner-protocol.js';
import {
  compactPlannerMessagesOnce,
  countTokensWithFallback,
  estimateTokenCount,
  preflightPlannerPromptBudget,
} from './prompt-budget.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  buildTerminalSynthesisFallback,
  buildTerminalSynthesisPrompt,
  type HistoryEntry,
  type TaskCommand,
} from './prompts.js';
import type {
  JsonLogger,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 45;
const DEFAULT_MAX_INVALID_RESPONSES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;
const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const PER_TOOL_RESULT_RATIO = 0.10;
const DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS = 2048;
const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
const FORCED_FINISH_MAX_ATTEMPTS = 3;
const NON_THINKING_FINISH_FOLLOWUP_PROMPT = 'Are you sure you have enough evidence and did not get tunnel-visioned?';
const ANSI_RED_CODE = 31;

// ---------------------------------------------------------------------------
// Slot allocation
// ---------------------------------------------------------------------------

let nextLlamaCppSlotId = 0;

function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getConfiguredLlamaSetting<number>(config, 'ParallelSlots');
  const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
  const slotId = nextLlamaCppSlotId % slotCount;
  nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
  return slotId;
}

// ---------------------------------------------------------------------------
// Task definitions (built-in self-test pack)
// ---------------------------------------------------------------------------

export type TaskDefinition = {
  id: string;
  question: string;
  signals: string[];
};

export const TASK_PACK: TaskDefinition[] = [
  {
    id: 'symbol-location',
    question: 'Find where buildPlannerToolDefinitions is defined. Return file path and nearby signature text.',
    signals: ['src[\\\\/]summary\\.ts', 'buildPlannerToolDefinitions'],
  },
  {
    id: 'call-path',
    question: 'Find what function invokes invokePlannerMode in summary flow. Return caller function name.',
    signals: ['invokePlannerMode', 'invokeSummaryCore'],
  },
  {
    id: 'config-runtime-key',
    question: 'Find where getConfiguredLlamaNumCtx is defined and at least one usage site.',
    signals: ['src[\\\\/]config\\.ts', 'getConfiguredLlamaNumCtx'],
  },
  {
    id: 'planner-tools',
    question: 'Find planner tool names in SiftKit and list them.',
    signals: ['find_text', 'read_lines', 'json_filter'],
  },
  {
    id: 'debug-artifacts',
    question: 'Find where planner debug dumps are written and show filename pattern.',
    signals: ['planner_debug_', 'getRuntimeLogsPath'],
  },
];

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function executeRepoCommand(
  command: string,
  repoRoot: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | null,
): Promise<{ exitCode: number; output: string }> {
  if (mockCommandResults && Object.prototype.hasOwnProperty.call(mockCommandResults, command)) {
    const result = mockCommandResults[command];
    const delayMs = Number(result.delayMs ?? 0);
    return new Promise((resolve) => {
      const complete = (): void => resolve({
        exitCode: Number(result.exitCode ?? 1),
        output: `${String(result.stdout || '')}${String(result.stderr || '')}`.trim(),
      });
      if (Number.isFinite(delayMs) && delayMs > 0) {
        setTimeout(complete, delayMs);
      } else {
        complete();
      }
    });
  }

  return spawnPowerShellAsync(command, { cwd: repoRoot }).then((result) => ({
    exitCode: result.exitCode,
    output: result.output,
  }));
}

// ---------------------------------------------------------------------------
// Signal evaluation
// ---------------------------------------------------------------------------

function evaluateTaskSignals(task: TaskDefinition, evidenceText: string): {
  passed: boolean;
  missingSignals: string[];
} {
  const missingSignals: string[] = [];
  for (const signal of task.signals) {
    const regex = new RegExp(signal, 'iu');
    if (!regex.test(evidenceText)) {
      missingSignals.push(signal);
    }
  }
  return { passed: missingSignals.length === 0, missingSignals };
}

// ---------------------------------------------------------------------------
// Request max-tokens resolution
// ---------------------------------------------------------------------------

export function resolveRepoSearchRequestMaxTokens(options: {
  config?: SiftConfig;
  requestMaxTokens?: number;
} = {}): number {
  const explicitMaxTokens = Number(options.requestMaxTokens);
  if (Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    return Math.floor(explicitMaxTokens);
  }
  const configuredMaxTokens = Number(getConfiguredLlamaSetting(options.config || {} as SiftConfig, 'MaxTokens'));
  if (Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0) {
    return Math.floor(Math.min(configuredMaxTokens, DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS));
  }
  return DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Console helper
// ---------------------------------------------------------------------------

function writeRedConsoleLine(message: string): void {
  if (!message) return;
  process.stderr.write(`${colorize(String(message), ANSI_RED_CODE, { isTTY: true })}\n`);
}

// ---------------------------------------------------------------------------
// Task result type
// ---------------------------------------------------------------------------

export type TaskResult = {
  id: string;
  question: string;
  reason: string;
  turnsUsed: number;
  safetyRejects: number;
  invalidResponses: number;
  commandFailures: number;
  commands: TaskCommand[];
  finalOutput: string;
  passed: boolean;
  missingSignals: string[];
  promptTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
};

// ---------------------------------------------------------------------------
// Main task loop
// ---------------------------------------------------------------------------

type RunTaskLoopOptions = {
  repoRoot: string;
  model: string;
  baseUrl: string;
  config?: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  thinkingInterval?: number;
  requestMaxTokens: number;
  enforceThinkingFinish?: boolean;
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
};

export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  const taskStartedAt = Date.now();
  const maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
  const maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
  const history: HistoryEntry[] = [];
  const commands: TaskCommand[] = [];
  let finalOutput = '';
  let invalidResponses = 0;
  let commandFailures = 0;
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
  let forceThinkingOnNextTurn = false;
  let modelPromptTokens = 0;
  let modelPromptCacheTokens = 0;
  let modelPromptEvalTokens = 0;
  const attemptedCommands = new Set<string>();
  const minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
  const thinkingInterval = Math.max(1, Math.floor(Number(options.thinkingInterval || 5)));
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000)));
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const requestMaxTokens = options.requestMaxTokens;
  const followupOnNonThinkingFinish = options.enforceThinkingFinish === true;
  let zeroOutputStreak = 0;
  let forcedFinishAttemptsRemaining = 0;
  let previousPlannerThinkingEnabled: boolean | null = null;
  let nonThinkingFinishFollowupUsed = false;
  const slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
  const ignorePolicy = buildIgnorePolicy(options.repoRoot);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildTaskSystemPrompt(options.repoRoot) },
    { role: 'user', content: buildTaskInitialUserPrompt(task.question) },
  ];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turnsUsed = turn;
    const inForcedFinishMode = forcedFinishAttemptsRemaining > 0;
    const plannerThinkingEnabled = inForcedFinishMode
      ? true
      : (forceThinkingOnNextTurn || (((commands.length + 1) % thinkingInterval) === 0));
    if (forceThinkingOnNextTurn && !inForcedFinishMode) {
      forceThinkingOnNextTurn = false;
    }

    let prompt = renderTaskTranscript(messages);
    let preflight = await preflightPlannerPromptBudget({
      config: options.config,
      prompt,
      totalContextTokens,
      thinkingBufferTokens,
      requestMaxTokens,
    });

    options.logger?.write({
      kind: 'turn_preflight_budget', taskId: task.id, turn,
      promptTokenCount: preflight.promptTokenCount, maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens, ok: preflight.ok, compacted: false,
    });

    if (!preflight.ok) {
      const compacted = await compactPlannerMessagesOnce({
        messages, config: options.config, maxPromptBudget: preflight.maxPromptBudget,
      });
      messages.splice(0, messages.length, ...compacted.messages);
      prompt = renderTaskTranscript(messages);
      const afterCompaction = await preflightPlannerPromptBudget({
        config: options.config, prompt, totalContextTokens, thinkingBufferTokens, requestMaxTokens,
      });
      options.logger?.write({
        kind: 'turn_preflight_compaction_applied', taskId: task.id, turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryInserted: compacted.summaryInserted,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} `
        + `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} `
        + `request_max_tokens=${requestMaxTokens} total_context_tokens=${totalContextTokens} `
        + `thinking_buffer_tokens=${thinkingBufferTokens}`,
      );
      options.logger?.write({
        kind: 'turn_preflight_overflow_fail', taskId: task.id, turn,
        promptTokenCount: preflight.promptTokenCount, maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens, requestMaxTokens, totalContextTokens, thinkingBufferTokens,
        error: overflowError.message,
      });
      throw overflowError;
    }

    options.logger?.write({ kind: 'turn_model_request', taskId: task.id, turn, thinkingEnabled: plannerThinkingEnabled });
    options.logger?.write({ kind: 'turn_prompt', taskId: task.id, turn, prompt });

    const switchedThinkingMode = previousPlannerThinkingEnabled !== null && previousPlannerThinkingEnabled !== plannerThinkingEnabled;
    const maxProviderAttempts = switchedThinkingMode ? 2 : 1;
    let providerAttempt = 0;
    let response: PlannerActionResponse | null = null;

    while (providerAttempt < maxProviderAttempts) {
      providerAttempt += 1;
      try {
        response = await requestPlannerAction({
          baseUrl: options.baseUrl,
          model: options.model,
          messages,
          slotId,
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          requestMaxTokens,
          thinkingEnabled: plannerThinkingEnabled,
          stream: Boolean(options.onProgress),
          onThinkingDelta: options.onProgress
            ? (accThinking) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accThinking }); }
            : undefined,
          mockResponses: options.mockResponses,
          mockResponseIndex,
          logger: options.logger || null,
        });
        break;
      } catch (error) {
        const shouldRetry = providerAttempt < maxProviderAttempts && isTransientProviderError(error);
        if (!shouldRetry) throw error;
        options.logger?.write({
          kind: 'provider_request_retry', taskId: task.id, turn, stage: 'planner_action',
          attempt: providerAttempt, nextAttempt: providerAttempt + 1,
          thinkingEnabled: plannerThinkingEnabled,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!response) throw new Error('No response received from planner.');

    if (response.thinkingText && options.onProgress) {
      options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: response.thinkingText });
    }
    previousPlannerThinkingEnabled = plannerThinkingEnabled;
    if (typeof response.nextMockResponseIndex === 'number') {
      mockResponseIndex = response.nextMockResponseIndex;
    }

    options.logger?.write({
      kind: 'turn_model_response', taskId: task.id, turn,
      text: response.text, thinkingText: response.thinkingText || '',
      mockExhausted: Boolean(response.mockExhausted),
      promptTokens: Number.isFinite(response.promptTokens) ? Number(response.promptTokens) : null,
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
    });

    if (Number.isFinite(response.promptTokens) && Number(response.promptTokens) >= 0) modelPromptTokens += Number(response.promptTokens);
    if (Number.isFinite(response.promptCacheTokens) && Number(response.promptCacheTokens) >= 0) modelPromptCacheTokens += Number(response.promptCacheTokens);
    if (Number.isFinite(response.promptEvalTokens) && Number(response.promptEvalTokens) >= 0) modelPromptEvalTokens += Number(response.promptEvalTokens);

    if (response.mockExhausted) { reason = 'mock_responses_exhausted'; break; }

    let action;
    try {
      action = parsePlannerAction(response.text);
      options.logger?.write({ kind: 'turn_action_parsed', taskId: task.id, turn, action });
    } catch (error) {
      invalidResponses += 1;
      if (String(response.text || '').trim()) {
        messages.push({ role: 'assistant', content: String(response.text).trim() });
      }
      messages.push({ role: 'user', content: `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return exactly one valid JSON action.` });
      options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, invalidResponses, error: error instanceof Error ? error.message : String(error) });
      if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
      history.push({ command: '[invalid action]', resultText: `Invalid action: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    if (action.action === 'finish') {
      if (commands.length < minToolCallsBeforeFinish) {
        const warning = 'that was a shallow search, there might be more hidden references/usages. Dive deeper';
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: warning });
        history.push({ command: '[finish rejected]', resultText: warning });
        options.logger?.write({ kind: 'turn_finish_rejected', taskId: task.id, turn, toolCallTurns: commands.length, minToolCallsBeforeFinish, warning });
        continue;
      }
      if (followupOnNonThinkingFinish && !plannerThinkingEnabled && !nonThinkingFinishFollowupUsed) {
        nonThinkingFinishFollowupUsed = true;
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: NON_THINKING_FINISH_FOLLOWUP_PROMPT });
        history.push({ command: '[follow-up]', resultText: NON_THINKING_FINISH_FOLLOWUP_PROMPT });
        forceThinkingOnNextTurn = true;
        options.logger?.write({ kind: 'turn_non_thinking_finish_followup', taskId: task.id, turn, followupPrompt: NON_THINKING_FINISH_FOLLOWUP_PROMPT, forcedThinkingOnNextTurn: true });
        continue;
      }
      options.logger?.write({ kind: 'turn_finish_validation_skipped', taskId: task.id, turn, reason: 'planner_already_thinking' });
      finalOutput = action.output;
      reason = 'finish';
      break;
    }

    // Tool action
    const command = action.args.command;
    const toolCallId = `call_${commands.length + 1}`;

    if (attemptedCommands.has(command)) {
      const duplicateReason = 'Exact command was already executed';
      commandFailures += 1;
      commands.push({ command, safe: false, reason: duplicateReason, exitCode: null, output: `Rejected command: ${duplicateReason}` });
      messages.push(buildRepoSearchAssistantToolMessage(command, toolCallId));
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: `Rejected command: ${duplicateReason}` });
      history.push({ command, resultText: `Rejected command: ${duplicateReason}` });
      continue;
    }
    attemptedCommands.add(command);

    if (inForcedFinishMode) {
      forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
      const forcedReason = `Forced finish mode active. Return a finish action now. Attempts remaining: ${forcedFinishAttemptsRemaining}.`;
      commandFailures += 1;
      commands.push({ command, safe: false, reason: forcedReason, exitCode: null, output: `Rejected command: ${forcedReason}` });
      messages.push(buildRepoSearchAssistantToolMessage(command, toolCallId));
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: `Rejected command: ${forcedReason}` });
      history.push({ command, resultText: `Rejected command: ${forcedReason}` });
      if (forcedFinishAttemptsRemaining === 0) { reason = 'forced_finish_attempt_limit'; break; }
      continue;
    }

    const normalized = normalizePlannerCommand(command, { repoRoot: options.repoRoot, ignorePolicy });
    if (normalized.rejected) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      commands.push({ command, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      messages.push(buildRepoSearchAssistantToolMessage(command, toolCallId));
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: rejection });
      history.push({ command, resultText: rejection });
      continue;
    }

    const commandToRun = normalized.command;
    const safety = evaluateCommandSafety(commandToRun, options.repoRoot);
    options.logger?.write({ kind: 'turn_command_safety', taskId: task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({ command: commandToRun, safe: false, reason: safety.reason, exitCode: null, output: rejection });
      messages.push(buildRepoSearchAssistantToolMessage(commandToRun, toolCallId));
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: rejection });
      history.push({ command: commandToRun, resultText: rejection });
      continue;
    }

    const useEstimatedTokensOnly = Array.isArray(options.mockResponses);
    const promptTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, prompt)
      : await countTokensWithFallback(options.config, prompt);

    if (options.onProgress) {
      options.onProgress({ kind: 'tool_start', turn, maxTurns, command: commandToRun, promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }

    const executed = await executeRepoCommand(commandToRun, options.repoRoot, options.mockCommandResults || null);
    const baseOutput = String(executed.output || '').trim();

    if (options.onProgress) {
      const snippet = baseOutput.length > 200 ? baseOutput.slice(0, 200) + '...' : baseOutput;
      options.onProgress({ kind: 'tool_result', turn, maxTurns, command: commandToRun, exitCode: executed.exitCode, outputSnippet: snippet, promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }

    const outputWithRewriteNote = normalized.rewritten && normalized.note
      ? `${normalized.note}\n${baseOutput}`.trim()
      : baseOutput;

    if (Number(executed.exitCode) !== 0 && !isSearchNoMatchExit(commandToRun, executed.exitCode)) {
      commandFailures += 1;
    }

    if (outputWithRewriteNote.length === 0) {
      zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - zeroOutputStreak, 0);
      history.push({
        command: '[zero-output-warning]',
        resultText: remainingBeforeForce > 0
          ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
          : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`,
      });
      options.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: task.id, turn, zeroOutputStreak, remainingBeforeForce,
      });
      if (remainingBeforeForce === 0 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        messages.push({ role: 'user', content: 'Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.' });
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: forcedFinishAttemptsRemaining,
        });
      }
    } else {
      zeroOutputStreak = 0;
    }

    let resultText = `exit_code=${executed.exitCode}\n${outputWithRewriteNote}`.trim();
    const resultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, resultText)
      : await countTokensWithFallback(options.config, resultText);
    const dynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
    const perToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * dynamicPerToolRatio));
    const remainingTokenAllowance = Math.max(usablePromptTokens - promptTokenCount, 0);

    if (resultTokenCount > perToolCapTokens || resultTokenCount > remainingTokenAllowance) {
      resultText = `Error: requested output would consume ${resultTokenCount} tokens, remaining token allowance: ${remainingTokenAllowance}, per tool call allowance: ${perToolCapTokens}`;
      writeRedConsoleLine(`repo_search warning: ${resultText}`);
    }

    options.logger?.write({
      kind: 'turn_command_result', taskId: task.id, turn, command: commandToRun,
      exitCode: executed.exitCode, output: outputWithRewriteNote,
      promptTokenCount, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });

    commands.push({ command: commandToRun, safe: true, reason: null, exitCode: executed.exitCode, output: outputWithRewriteNote });
    messages.push(buildRepoSearchAssistantToolMessage(commandToRun, toolCallId));
    messages.push({ role: 'tool', tool_call_id: toolCallId, content: resultText });
    history.push({ command: commandToRun, resultText });
  }

  // Terminal synthesis if no final output
  if (!String(finalOutput || '').trim()) {
    let usedFallback = false;
    const synthesisPrompt = buildTerminalSynthesisPrompt({ question: task.question, reason, history });
    options.logger?.write({ kind: 'task_terminal_synthesis_requested', taskId: task.id, reason });

    try {
      const synthesisResponse = await requestTerminalSynthesis({
        baseUrl: options.baseUrl,
        model: options.model,
        prompt: synthesisPrompt,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        mockResponses: options.mockResponses,
        mockResponseIndex,
        requestMaxTokens,
        logger: options.logger || null,
      });
      if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
        mockResponseIndex = synthesisResponse.nextMockResponseIndex;
      }
      if (Number.isFinite(synthesisResponse.promptTokens) && Number(synthesisResponse.promptTokens) >= 0) modelPromptTokens += Number(synthesisResponse.promptTokens);
      if (Number.isFinite(synthesisResponse.promptCacheTokens) && Number(synthesisResponse.promptCacheTokens) >= 0) modelPromptCacheTokens += Number(synthesisResponse.promptCacheTokens);
      if (Number.isFinite(synthesisResponse.promptEvalTokens) && Number(synthesisResponse.promptEvalTokens) >= 0) modelPromptEvalTokens += Number(synthesisResponse.promptEvalTokens);

      if (!synthesisResponse.mockExhausted && String(synthesisResponse.text || '').trim()) {
        finalOutput = String(synthesisResponse.text).trim();
      } else {
        usedFallback = true;
        finalOutput = buildTerminalSynthesisFallback({ reason, commands });
      }
    } catch (error) {
      options.logger?.write({ kind: 'task_terminal_synthesis_error', taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      usedFallback = true;
      finalOutput = buildTerminalSynthesisFallback({ reason, commands });
    }
    options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: task.id, usedFallback, finalOutput });
  }

  const evidenceParts = [finalOutput, ...commands.map((item) => item.output)];
  const signalCheck = evaluateTaskSignals(task, evidenceParts.join('\n'));
  const passed = signalCheck.passed && commandFailures === 0;

  options.logger?.write({
    kind: 'task_done', taskId: task.id, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, passed, missingSignals: signalCheck.missingSignals,
  });

  return {
    id: task.id, question: task.question, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, commands, finalOutput, passed,
    missingSignals: signalCheck.missingSignals,
    promptTokens: modelPromptTokens, promptCacheTokens: modelPromptCacheTokens, promptEvalTokens: modelPromptEvalTokens,
  };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export type Scorecard = {
  runId: string;
  model: string;
  tasks: TaskResult[];
  totals: Record<string, number>;
  verdict: 'pass' | 'fail';
  failureReasons: string[];
};

export function buildScorecard(options: { runId: string; model: string; tasks: TaskResult[] }): Scorecard {
  const totals = {
    tasks: options.tasks.length,
    passed: options.tasks.filter((t) => t.passed).length,
    failed: options.tasks.filter((t) => !t.passed).length,
    commandsExecuted: options.tasks.reduce((s, t) => s + t.commands.length, 0),
    safetyRejects: options.tasks.reduce((s, t) => s + t.safetyRejects, 0),
    invalidResponses: options.tasks.reduce((s, t) => s + t.invalidResponses, 0),
    commandFailures: options.tasks.reduce((s, t) => s + Number(t.commandFailures || 0), 0),
    promptTokens: options.tasks.reduce((s, t) => s + Number(t.promptTokens || 0), 0),
    promptCacheTokens: options.tasks.reduce((s, t) => s + Number(t.promptCacheTokens || 0), 0),
    promptEvalTokens: options.tasks.reduce((s, t) => s + Number(t.promptEvalTokens || 0), 0),
  };

  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    if (task.missingSignals.length === 0 && Number(task.commandFailures || 0) === 0) failureReasons.push(`${task.id}: task failed`);
  }

  return {
    runId: options.runId,
    model: options.model,
    tasks: options.tasks,
    totals,
    verdict: totals.failed === 0 ? 'pass' : 'fail',
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// Model assertion
// ---------------------------------------------------------------------------

export function assertConfiguredModelPresent(model: string, availableModels: string[]): void {
  if (!Array.isArray(availableModels) || !availableModels.includes(model)) {
    throw new Error(`Configured model not found: ${model}. Available models: ${Array.isArray(availableModels) ? availableModels.join(', ') : 'none'}`);
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function runRepoSearch(options: {
  repoRoot?: string;
  config?: SiftConfig | Record<string, unknown>;
  model?: string;
  baseUrl?: string;
  requestMaxTokens?: number;
  maxTurns?: number;
  thinkingInterval?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  taskPrompt?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
} = {}): Promise<Scorecard> {
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const config = (options.config || await loadConfig({ ensure: true })) as SiftConfig;
  const model = options.model || getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const availableModels = options.availableModels || await listLlamaCppModels(config);
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = options.taskPrompt
    ? [{ id: 'repo-search', question: String(options.taskPrompt), signals: [] }]
    : TASK_PACK;

  const requestMaxTokens = resolveRepoSearchRequestMaxTokens({ config, requestMaxTokens: options.requestMaxTokens });
  const tasks: TaskResult[] = [];

  for (const task of tasksToRun) {
    const result = await runTaskLoop(task, {
      repoRoot,
      model,
      baseUrl,
      config,
      totalContextTokens: getConfiguredLlamaNumCtx(config),
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxTurns: options.maxTurns || DEFAULT_MAX_TURNS,
      maxInvalidResponses: options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES,
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,
      thinkingInterval: options.thinkingInterval,
      requestMaxTokens,
      enforceThinkingFinish: true,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      logger: options.logger || null,
      onProgress: options.onProgress || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return scorecard;
}
