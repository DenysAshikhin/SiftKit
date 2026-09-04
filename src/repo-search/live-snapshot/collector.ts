import type { JsonSerializable } from '../../lib/json-types.js';
import {
  ApprovalVerdictEventSchema,
  LIVE_SNAPSHOT_COMMAND_CHARS,
  LIVE_SNAPSHOT_MAX_TURNS,
  LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS,
  LoggerEventKindSchema,
  ProviderRequestDoneEventSchema,
  ProviderRequestErrorEventSchema,
  ProviderRequestStartEventSchema,
  RunStartEventSchema,
  TaskDoneEventSchema,
  TurnCommandResultEventSchema,
  TurnCommandStartEventSchema,
  TurnModelRequestEventSchema,
  TurnModelResponseEventSchema,
  TurnPreflightBudgetEventSchema,
  TurnPreflightStartEventSchema,
  type LiveRunPhaseName,
  type LiveRunSnapshot,
  type LiveRunTurn,
} from './schemas.js';

type MutableProviderRequest = {
  stage: string;
  startedAtMs: number;
  elapsedMs: number | null;
  statusCode: number | null;
  error: string | null;
};

type MutableTool = {
  toolName: string;
  command: string;
  startedAtMs: number;
  durationMs: number | null;
  exitCode: number | null;
  outputChars: number | null;
  outputTokens: number | null;
  outputHead: string;
  outputTail: string;
};

type MutableTurn = {
  turn: number;
  promptChars: number | null;
  promptTokens: number | null;
  tokenizeMs: number | null;
  tokenSource: string | null;
  maxPromptBudget: number | null;
  overflowTokens: number | null;
  maxOutputTokens: number | null;
  modelStartedAtMs: number | null;
  modelDurationMs: number | null;
  promptEvalTokens: number | null;
  promptCacheTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  stop: LiveRunTurn['stop'];
  providerRequests: MutableProviderRequest[];
  approval: { verdict: string; reason: string } | null;
  tool: MutableTool | null;
};

type MutablePhase = {
  name: LiveRunPhaseName;
  turn: number | null;
  startedAtMs: number;
  detail: string | null;
};

function optionalNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncateCommand(command: string): string {
  return command.length > LIVE_SNAPSHOT_COMMAND_CHARS
    ? `${command.slice(0, LIVE_SNAPSHOT_COMMAND_CHARS)}…`
    : command;
}

function splitOutputEdges(output: string): { head: string; tail: string } {
  if (output.length <= LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS * 2) {
    return { head: output, tail: '' };
  }
  return {
    head: output.slice(0, LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS),
    tail: output.slice(-LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS),
  };
}

function formatErrorValue(value: JsonSerializable | undefined): string {
  if (value === undefined || value === null) {
    return 'unknown error';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function topBy(
  turns: readonly MutableTurn[],
  pick: (turn: MutableTurn) => number | null,
): { turn: number; ms: number }[] {
  return turns
    .map((turn) => ({ turn: turn.turn, ms: pick(turn) }))
    .filter((entry): entry is { turn: number; ms: number } => entry.ms !== null)
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 5);
}

/**
 * Folds the transcript logger's event stream into a small, always-current picture
 * of the run. Pure: no IO, no timers.
 */
export class LiveRunSnapshotCollector {
  private readonly turns = new Map<number, MutableTurn>();
  private currentTurn: number | null = null;
  private model: string | null = null;
  private baseUrl: string | null = null;
  private lastError: string | null = null;
  private lastSnapshotWriteError: string | null = null;
  private finishReason: string | null = null;
  private phase: MutablePhase;
  private readonly counters = {
    providerRequests: 0,
    providerErrors: 0,
    rejectedCalls: 0,
    nonZeroExits: 0,
    safetyRejects: 0,
    approvalDenials: 0,
  };

  constructor(private readonly meta: {
    requestId: string;
    taskKind: string;
    repoRoot: string;
    startedAtMs: number;
  }) {
    this.phase = { name: 'starting', turn: null, startedAtMs: meta.startedAtMs, detail: null };
  }

  recordWriteError(message: string): void {
    this.lastSnapshotWriteError = message;
  }

  recordRunError(message: string): void {
    this.lastError = message;
  }

  record(event: Record<string, JsonSerializable>): void {
    const parsedKind = LoggerEventKindSchema.safeParse(event);
    if (!parsedKind.success) {
      return;
    }
    switch (parsedKind.data.kind) {
      case 'run_start': return this.onRunStart(event);
      case 'turn_preflight_start': return this.onPreflightStart(event);
      case 'turn_preflight_budget': return this.onPreflightBudget(event);
      case 'turn_model_request': return this.onModelRequest(event);
      case 'provider_request_start': return this.onProviderStart(event);
      case 'provider_request_done': return this.onProviderDone(event);
      case 'provider_request_error': return this.onProviderError(event);
      case 'turn_model_response': return this.onModelResponse(event);
      case 'approval_verdict': return this.onApprovalVerdict(event);
      case 'turn_command_start': return this.onCommandStart(event);
      case 'turn_command_result': return this.onCommandResult(event);
      case 'task_done': return this.onTaskDone(event);
      case 'run_done': return this.setPhase('done', null, null);
      default: return undefined;
    }
  }

  build(): LiveRunSnapshot {
    const now = Date.now();
    const ordered = [...this.turns.values()].sort((left, right) => left.turn - right.turn);
    const visible = ordered.slice(-LIVE_SNAPSHOT_MAX_TURNS);
    return {
      requestId: this.meta.requestId,
      taskKind: this.meta.taskKind,
      pid: process.pid,
      repoRoot: this.meta.repoRoot,
      model: this.model,
      baseUrl: this.baseUrl,
      startedAtUtc: new Date(this.meta.startedAtMs).toISOString(),
      snapshotAtUtc: new Date(now).toISOString(),
      elapsedMs: Math.max(0, now - this.meta.startedAtMs),
      phase: {
        name: this.phase.name,
        turn: this.phase.turn,
        startedAtUtc: new Date(this.phase.startedAtMs).toISOString(),
        elapsedMs: Math.max(0, now - this.phase.startedAtMs),
        detail: this.phase.detail,
      },
      turnsRecorded: ordered.length,
      turns: visible.map((turn) => this.toSnapshotTurn(turn)),
      totals: {
        modelMs: sum(ordered.map((turn) => turn.modelDurationMs)),
        toolMs: sum(ordered.map((turn) => turn.tool?.durationMs ?? null)),
        promptEvalTokens: sum(ordered.map((turn) => turn.promptEvalTokens)),
        promptCacheTokens: sum(ordered.map((turn) => turn.promptCacheTokens)),
        completionTokens: sum(ordered.map((turn) => turn.completionTokens)),
        toolOutputChars: sum(ordered.map((turn) => turn.tool?.outputChars ?? null)),
      },
      slowest: {
        byModelMs: topBy(ordered, (turn) => turn.modelDurationMs),
        byToolMs: topBy(ordered, (turn) => turn.tool?.durationMs ?? null),
      },
      counters: {
        turns: ordered.length,
        providerRequests: this.counters.providerRequests,
        providerErrors: this.counters.providerErrors,
        rejectedCalls: this.counters.rejectedCalls,
        nonZeroExits: this.counters.nonZeroExits,
        safetyRejects: this.counters.safetyRejects,
        approvalDenials: this.counters.approvalDenials,
      },
      health: {
        lastError: this.lastError,
        lastSnapshotWriteError: this.lastSnapshotWriteError,
        finishReason: this.finishReason,
      },
    };
  }

  private toSnapshotTurn(turn: MutableTurn): LiveRunTurn {
    return {
      turn: turn.turn,
      promptChars: turn.promptChars,
      promptTokens: turn.promptTokens,
      tokenizeMs: turn.tokenizeMs,
      tokenSource: turn.tokenSource,
      maxPromptBudget: turn.maxPromptBudget,
      overflowTokens: turn.overflowTokens,
      maxOutputTokens: turn.maxOutputTokens,
      modelDurationMs: turn.modelDurationMs,
      promptEvalTokens: turn.promptEvalTokens,
      promptCacheTokens: turn.promptCacheTokens,
      completionTokens: turn.completionTokens,
      thinkingTokens: turn.thinkingTokens,
      stop: turn.stop,
      providerRequests: turn.providerRequests.map((request) => ({
        stage: request.stage,
        startedAtUtc: new Date(request.startedAtMs).toISOString(),
        elapsedMs: request.elapsedMs,
        statusCode: request.statusCode,
        error: request.error,
      })),
      approval: turn.approval,
      tool: turn.tool === null ? null : {
        toolName: turn.tool.toolName,
        command: turn.tool.command,
        startedAtUtc: new Date(turn.tool.startedAtMs).toISOString(),
        durationMs: turn.tool.durationMs,
        exitCode: turn.tool.exitCode,
        outputChars: turn.tool.outputChars,
        outputTokens: turn.tool.outputTokens,
        outputHead: turn.tool.outputHead,
        outputTail: turn.tool.outputTail,
      },
    };
  }

  private ensureTurn(turn: number): MutableTurn {
    const existing = this.turns.get(turn);
    if (existing) {
      return existing;
    }
    const created: MutableTurn = {
      turn,
      promptChars: null,
      promptTokens: null,
      tokenizeMs: null,
      tokenSource: null,
      maxPromptBudget: null,
      overflowTokens: null,
      maxOutputTokens: null,
      modelStartedAtMs: null,
      modelDurationMs: null,
      promptEvalTokens: null,
      promptCacheTokens: null,
      completionTokens: null,
      thinkingTokens: null,
      stop: null,
      providerRequests: [],
      approval: null,
      tool: null,
    };
    this.turns.set(turn, created);
    this.currentTurn = turn;
    return created;
  }

  private setPhase(name: LiveRunPhaseName, turn: number | null, detail: string | null): void {
    this.phase = { name, turn, startedAtMs: Date.now(), detail };
  }

  private onRunStart(event: Record<string, JsonSerializable>): void {
    const parsed = RunStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.model = parsed.data.configuredModel ?? null;
    this.baseUrl = parsed.data.baseUrl ?? null;
  }

  private onPreflightStart(event: Record<string, JsonSerializable>): void {
    const parsed = TurnPreflightStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.currentTurn = parsed.data.turn;
    this.ensureTurn(parsed.data.turn).promptChars = optionalNumber(parsed.data.promptChars);
    this.setPhase('prompt_preflight', parsed.data.turn, null);
  }

  private onPreflightBudget(event: Record<string, JsonSerializable>): void {
    const parsed = TurnPreflightBudgetEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    turn.promptTokens = optionalNumber(parsed.data.promptTokenCount);
    turn.tokenizeMs = optionalNumber(parsed.data.tokenizeElapsedMs);
    turn.tokenSource = parsed.data.tokenCountSource ?? null;
    turn.maxPromptBudget = optionalNumber(parsed.data.maxPromptBudget);
    turn.overflowTokens = optionalNumber(parsed.data.overflowTokens);
    turn.maxOutputTokens = optionalNumber(parsed.data.maxOutputTokens);
  }

  private onModelRequest(event: Record<string, JsonSerializable>): void {
    const parsed = TurnModelRequestEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.currentTurn = parsed.data.turn;
    this.ensureTurn(parsed.data.turn).modelStartedAtMs = Date.now();
    this.setPhase('model_request', parsed.data.turn, null);
  }

  private onProviderStart(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestStartEventSchema.safeParse(event);
    if (!parsed.success || this.currentTurn === null) {
      return;
    }
    this.ensureTurn(this.currentTurn).providerRequests.push({
      stage: parsed.data.stage,
      startedAtMs: Date.now(),
      elapsedMs: null,
      statusCode: null,
      error: null,
    });
    this.setPhase('model_request', this.currentTurn, `stage=${parsed.data.stage}`);
  }

  private closeProviderRequest(
    stage: string,
    elapsedMs: number | null,
    statusCode: number | null,
    error: string | null,
  ): void {
    if (this.currentTurn === null) {
      return;
    }
    const requests = this.ensureTurn(this.currentTurn).providerRequests;
    const open = [...requests].reverse().find((request) => request.stage === stage && request.elapsedMs === null);
    if (open === undefined) {
      requests.push({ stage, startedAtMs: Date.now(), elapsedMs, statusCode, error });
      return;
    }
    open.elapsedMs = elapsedMs ?? Math.max(0, Date.now() - open.startedAtMs);
    open.statusCode = statusCode;
    open.error = error;
  }

  private onProviderDone(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestDoneEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.counters.providerRequests += 1;
    this.closeProviderRequest(
      parsed.data.stage,
      optionalNumber(parsed.data.elapsedMs),
      optionalNumber(parsed.data.statusCode),
      null,
    );
  }

  private onProviderError(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestErrorEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.counters.providerErrors += 1;
    const message = formatErrorValue(parsed.data.error);
    this.lastError = message;
    this.closeProviderRequest(parsed.data.stage, optionalNumber(parsed.data.elapsedMs), null, message);
  }

  private onModelResponse(event: Record<string, JsonSerializable>): void {
    const parsed = TurnModelResponseEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    turn.modelDurationMs = turn.modelStartedAtMs === null
      ? null
      : Math.max(0, Date.now() - turn.modelStartedAtMs);
    turn.promptTokens = optionalNumber(parsed.data.promptTokens) ?? turn.promptTokens;
    turn.completionTokens = optionalNumber(parsed.data.completionTokens);
    turn.thinkingTokens = optionalNumber(parsed.data.thinkingTokens);
    turn.stop = parsed.data.stop;
    turn.promptCacheTokens = optionalNumber(parsed.data.promptCacheTokens);
    turn.promptEvalTokens = optionalNumber(parsed.data.promptEvalTokens);
    this.setPhase('idle', parsed.data.turn, null);
  }

  private onApprovalVerdict(event: Record<string, JsonSerializable>): void {
    const parsed = ApprovalVerdictEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.ensureTurn(parsed.data.turn).approval = {
      verdict: parsed.data.verdict,
      reason: parsed.data.reason,
    };
    if (parsed.data.verdict === 'deny') {
      this.counters.approvalDenials += 1;
    }
  }

  private onCommandStart(event: Record<string, JsonSerializable>): void {
    const parsed = TurnCommandStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const command = truncateCommand(parsed.data.commandToRun);
    this.ensureTurn(parsed.data.turn).tool = {
      toolName: parsed.data.toolName,
      command,
      startedAtMs: Date.now(),
      durationMs: null,
      exitCode: null,
      outputChars: null,
      outputTokens: null,
      outputHead: '',
      outputTail: '',
    };
    this.setPhase('tool_execute', parsed.data.turn, command);
  }

  private onCommandResult(event: Record<string, JsonSerializable>): void {
    const parsed = TurnCommandResultEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    const output = parsed.data.output ?? '';
    const edges = splitOutputEdges(output);
    const exitCode = optionalNumber(parsed.data.exitCode);
    const existing = turn.tool;
    turn.tool = {
      toolName: existing?.toolName ?? parsed.data.toolName ?? 'unknown',
      command: existing?.command ?? truncateCommand(parsed.data.command),
      startedAtMs: existing?.startedAtMs ?? Date.now(),
      durationMs: existing === null ? null : Math.max(0, Date.now() - existing.startedAtMs),
      exitCode,
      outputChars: output.length,
      outputTokens: optionalNumber(parsed.data.resultTokenCount),
      outputHead: edges.head,
      outputTail: edges.tail,
    };
    if (exitCode !== null && exitCode !== 0) {
      this.counters.nonZeroExits += 1;
    }
    // Rejections split the same way the engine splits them, so the snapshot and the scorecard
    // report the same numbers: a screened call is a safety reject, not a refused call.
    if ('rejectionKind' in parsed.data) {
      if (parsed.data.rejectionKind === 'safety') {
        this.counters.safetyRejects += 1;
      } else {
        this.counters.rejectedCalls += 1;
      }
    }
    this.setPhase('idle', parsed.data.turn, null);
  }

  private onTaskDone(event: Record<string, JsonSerializable>): void {
    const parsed = TaskDoneEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.finishReason = parsed.data.reason ?? null;
    this.setPhase('done', null, null);
  }
}
