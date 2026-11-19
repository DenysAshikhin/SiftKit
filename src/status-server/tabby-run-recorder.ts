import { setTimeout as delay } from 'node:timers/promises';

import { getErrorMessage } from '../lib/errors.ts';
import { insertEngineEvent, type EngineEventInput } from '../state/engine-events.ts';
import type { InferenceRunStatus, InferenceRunStreamKind } from '../state/inference-runs.ts';
import { getRuntimeDatabase } from '../state/runtime-db.ts';
import { InferenceRunRecorder } from './inference-run-recorder.ts';
import { serverLogger } from './server-logger.ts';

const MTP_DRAFTING_MARKER = 'Using main model MTP component for drafting';
const PYTHON_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception): .+/u;
// TabbyAPI starts every log record with `HH:MM:SS.mmm LEVEL:`; other lines continue the open record.
const LOG_RECORD_START = /^\d{2}:\d{2}:\d{2}\.\d{3} [A-Z]+:/u;
const ERROR_RECORD_START = /^\d{2}:\d{2}:\d{2}\.\d{3} (?:ERROR|CRITICAL):\s*(.*)$/u;
// winloop raises this when TabbyAPI writes a reply to a client that already hung up: a disconnect, not an engine fault.
const CLIENT_DISCONNECT_EXCEPTION = /^RuntimeError: Cannot call write\(\) when UVStream is clos(?:ed|ing)$/u;
// TabbyAPI logs its 503 reply to a request made while no model is loaded, as SiftKit's post-unload probe does: not an engine fault.
const NO_MODEL_REPLY = 'Sent to request: No models are currently loaded.';
// Exception-group tracebacks prefix their lines with `|` and `+`.
const TRACEBACK_PREFIX = /^[\s|+]*/u;
const EXIT_DETAIL_LINES = 40;
// exllamav3 evicts at its budget silently; its periodic tier report and the load report show usage against the budget.
const DISK_TIER_REPORT = /Disk cache tier: .*On disk: \d+ pages, \d+ checkpoints, ([\d.]+) of ([\d.]+) GB/u;
const DISK_LOAD_REPORT = /Disk cache: .+ holds \d+ pages \(([\d,]+) reusable tokens\).*, ([\d.]+) GB of ([\d.]+) GB/u;
const DISK_OUT_OF_SPACE = /Disk cache tier: (.+\)); writes paused/u;
// Reports round to 0.1 GB, and eviction keeps the cache within one page or checkpoint of its budget.
const DISK_FULL_MARGIN_GB = 0.1;
const DISK_FULL_ADVICE = 'exllamav3 evicts its oldest pages, so long prompts lose their start. Raise the preset\'s disk cache budget.';

type EngineStreamKind = 'engine_stdout' | 'engine_stderr';
type OpenErrorRecord = { message: string; lines: string[]; exception: string | null; clientDisconnect: boolean };

/** Tracks startup facts, engine errors, and unrequested exits directly from TabbyAPI streams. */
export class TabbyRunRecorder extends InferenceRunRecorder {
  private readonly trailingTextByStream = new Map<InferenceRunStreamKind, string>();
  private readonly partialLineByStream = new Map<EngineStreamKind, string>();
  private readonly openRecordByStream = new Map<EngineStreamKind, OpenErrorRecord>();
  private readonly recentStderrLines: string[] = [];
  private mtpDraftingMarkerSeen = false;
  /** Each disk cache problem is recorded once per engine run, though the engine keeps reporting it. */
  private readonly diskCacheProblems = new Set<'budget' | 'space'>();
  private lastEngineErrorLine: string | null = null;
  private readyReached = false;
  private engineStderrEnd: Promise<void> = Promise.resolve();

  hasMtpDraftingMarker(): boolean {
    return this.mtpDraftingMarkerSeen;
  }

  /** The last Python exception line the engine wrote to stderr, e.g. `RuntimeError: ...`. */
  lastEngineError(): string | null {
    return this.lastEngineErrorLine;
  }

  override attachEngineStdout(stream: NodeJS.ReadableStream | null): void {
    super.attachEngineStdout(stream);
    stream?.once('end', () => this.endEngineStream('engine_stdout'));
  }

  override attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
    super.attachEngineStderr(stream);
    if (stream === null) return;
    // A last line without a newline is observed once the stream ends.
    this.engineStderrEnd = new Promise((resolve) => {
      stream.once('end', () => {
        this.endEngineStream('engine_stderr');
        resolve();
      });
    });
  }

  /** Resolves once engine stderr has ended and its last line is observed, or after `timeoutMs`. */
  async waitForEngineStderrEnd(timeoutMs: number): Promise<void> {
    await Promise.race([this.engineStderrEnd, delay(timeoutMs, undefined, { ref: false })]);
  }

  /** An engine that was ready and then failed without being stopped is recorded as an engine exit. */
  override finish(options: { status: InferenceRunStatus; exitCode?: number | null; errorMessage?: string | null; baseUrl?: string | null }): void {
    if (options.status === 'ready') this.readyReached = true;
    if (options.status === 'failed' && this.readyReached) {
      const engineError = this.lastEngineErrorLine === null ? '' : `: ${this.lastEngineErrorLine}`;
      this.recordEngineEvent({
        kind: 'engine_exit', inferenceRunId: this.runId, runId: null, turn: null,
        summary: `Engine exited with code ${String(options.exitCode ?? null)}${engineError}`,
        detail: this.recentStderrLines.join('\n'),
      });
    }
    super.finish(options);
  }

  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    if (streamKind === 'engine_stdout' || streamKind === 'engine_stderr') this.observeEngineText(streamKind, chunkText);
    if (this.mtpDraftingMarkerSeen) return;
    const combined = `${this.trailingTextByStream.get(streamKind) ?? ''}${chunkText}`;
    if (combined.includes(MTP_DRAFTING_MARKER)) {
      this.mtpDraftingMarkerSeen = true;
      this.trailingTextByStream.clear();
      return;
    }
    this.trailingTextByStream.set(streamKind, combined.slice(-(MTP_DRAFTING_MARKER.length - 1)));
  }

  private endEngineStream(streamKind: EngineStreamKind): void {
    this.observeEngineText(streamKind, '\n');
    this.closeErrorRecord(streamKind);
  }

  private observeEngineText(streamKind: EngineStreamKind, chunkText: string): void {
    const lines = `${this.partialLineByStream.get(streamKind) ?? ''}${chunkText}`.split('\n');
    this.partialLineByStream.set(streamKind, lines.pop() ?? '');
    for (const line of lines) this.observeEngineLine(streamKind, line.replace(/\r/gu, '').trimEnd());
  }

  private observeEngineLine(streamKind: EngineStreamKind, line: string): void {
    const exceptionCandidate = line.replace(TRACEBACK_PREFIX, '');
    const isException = PYTHON_EXCEPTION_LINE.test(exceptionCandidate) && !CLIENT_DISCONNECT_EXCEPTION.test(exceptionCandidate);
    if (streamKind === 'engine_stderr') {
      if (isException) this.lastEngineErrorLine = exceptionCandidate;
      this.recentStderrLines.push(line);
      if (this.recentStderrLines.length > EXIT_DETAIL_LINES) this.recentStderrLines.shift();
    }
    this.observeDiskCacheLine(line);
    if (LOG_RECORD_START.test(line)) {
      this.closeErrorRecord(streamKind);
      const errorStart = ERROR_RECORD_START.exec(line);
      if (errorStart !== null) this.openRecordByStream.set(streamKind, { message: (errorStart[1] ?? '').trim(), lines: [line], exception: null, clientDisconnect: false });
      return;
    }
    const record = this.openRecordByStream.get(streamKind);
    if (record === undefined) return;
    record.lines.push(line);
    if (isException) record.exception = exceptionCandidate;
    if (CLIENT_DISCONNECT_EXCEPTION.test(exceptionCandidate)) record.clientDisconnect = true;
  }

  private closeErrorRecord(streamKind: EngineStreamKind): void {
    const record = this.openRecordByStream.get(streamKind);
    if (record === undefined) return;
    this.openRecordByStream.delete(streamKind);
    if (record.clientDisconnect || record.message === NO_MODEL_REPLY) return;
    this.recordEngineEvent({
      kind: 'engine_error', inferenceRunId: this.runId, runId: null, turn: null,
      summary: record.exception === null ? record.message : `${record.message} — ${record.exception}`,
      detail: record.lines.join('\n'),
    });
  }

  private observeDiskCacheLine(line: string): void {
    const usage = readDiskUsage(line);
    if (usage !== null && Number(usage.budgetGb) > 0 && Number(usage.usedGb) >= Number(usage.budgetGb) - DISK_FULL_MARGIN_GB) {
      const tokens = usage.reusableTokens === null ? '' : `, ${usage.reusableTokens} reusable tokens`;
      this.recordDiskCacheProblem('budget', `Disk cache full (${usage.usedGb} of ${usage.budgetGb} GB${tokens}): ${DISK_FULL_ADVICE}`, line);
      return;
    }
    const outOfSpace = DISK_OUT_OF_SPACE.exec(line)?.[1];
    if (outOfSpace !== undefined) {
      this.recordDiskCacheProblem('space', `Disk cache out of space: ${outOfSpace}; exllamav3 paused its writes.`, line);
    }
  }

  private recordDiskCacheProblem(problem: 'budget' | 'space', summary: string, line: string): void {
    if (this.diskCacheProblems.has(problem)) return;
    this.diskCacheProblems.add(problem);
    serverLogger.warning({ scope: 'exl3', id: this.runId.slice(0, 8), event: 'disk_cache_full', fields: '', alert: summary });
    this.recordEngineEvent({ kind: 'disk_cache_full', inferenceRunId: this.runId, runId: null, turn: null, summary, detail: line });
  }

  /** Stream handlers must not throw, so a failed write is logged with the event it lost. */
  private recordEngineEvent(input: EngineEventInput): void {
    try {
      insertEngineEvent(getRuntimeDatabase(), input);
    } catch (error) {
      serverLogger.emitBody('engine', this.runId, { event: 'engine_event_lost', fields: `${input.summary}: ${getErrorMessage(error)}`, severity: 'error' });
    }
  }
}

/** Disk usage as a tier or load report prints it; the numbers stay as printed so a summary repeats them verbatim. */
function readDiskUsage(line: string): { usedGb: string; budgetGb: string; reusableTokens: string | null } | null {
  const tier = DISK_TIER_REPORT.exec(line);
  if (tier?.[1] !== undefined && tier[2] !== undefined) return { usedGb: tier[1], budgetGb: tier[2], reusableTokens: null };
  const load = DISK_LOAD_REPORT.exec(line);
  if (load?.[1] !== undefined && load[2] !== undefined && load[3] !== undefined) return { usedGb: load[2], budgetGb: load[3], reusableTokens: load[1] };
  return null;
}
