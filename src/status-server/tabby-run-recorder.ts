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
// Exception-group tracebacks prefix their lines with `|` and `+`.
const TRACEBACK_PREFIX = /^[\s|+]*/u;
const EXIT_DETAIL_LINES = 40;

type EngineStreamKind = 'engine_stdout' | 'engine_stderr';
type OpenErrorRecord = { message: string; lines: string[]; exception: string | null; clientDisconnect: boolean };

/** Tracks startup facts, engine errors, and unrequested exits directly from TabbyAPI streams. */
export class TabbyRunRecorder extends InferenceRunRecorder {
  private readonly trailingTextByStream = new Map<InferenceRunStreamKind, string>();
  private readonly partialLineByStream = new Map<EngineStreamKind, string>();
  private readonly openRecordByStream = new Map<EngineStreamKind, OpenErrorRecord>();
  private readonly recentStderrLines: string[] = [];
  private mtpDraftingMarkerSeen = false;
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
    if (record.clientDisconnect) return;
    this.recordEngineEvent({
      kind: 'engine_error', inferenceRunId: this.runId, runId: null, turn: null,
      summary: record.exception === null ? record.message : `${record.message} — ${record.exception}`,
      detail: record.lines.join('\n'),
    });
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
