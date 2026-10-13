import { setTimeout as delay } from 'node:timers/promises';

import type { InferenceRunStreamKind } from '../state/inference-runs.ts';
import { InferenceRunRecorder } from './inference-run-recorder.ts';

const MTP_DRAFTING_MARKER = 'Using main model MTP component for drafting';
const PYTHON_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception): .+/u;

/** Tracks startup facts directly from TabbyAPI streams before asynchronous log persistence. */
export class TabbyRunRecorder extends InferenceRunRecorder {
  private readonly trailingTextByStream = new Map<InferenceRunStreamKind, string>();
  private mtpDraftingMarkerSeen = false;
  private engineStderrPartialLine = '';
  private lastEngineErrorLine: string | null = null;
  private engineStderrEnd: Promise<void> = Promise.resolve();

  hasMtpDraftingMarker(): boolean {
    return this.mtpDraftingMarkerSeen;
  }

  /** The last Python exception line the engine wrote to stderr, e.g. `RuntimeError: ...`. */
  lastEngineError(): string | null {
    return this.lastEngineErrorLine;
  }

  override attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
    super.attachEngineStderr(stream);
    if (stream === null) return;
    // A last line without a newline is observed once the stream ends.
    this.engineStderrEnd = new Promise((resolve) => {
      stream.once('end', () => {
        this.observeEngineStderr('\n');
        resolve();
      });
    });
  }

  /** Resolves once engine stderr has ended and its last line is observed, or after `timeoutMs`. */
  async waitForEngineStderrEnd(timeoutMs: number): Promise<void> {
    await Promise.race([this.engineStderrEnd, delay(timeoutMs, undefined, { ref: false })]);
  }

  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    if (streamKind === 'engine_stderr') this.observeEngineStderr(chunkText);
    if (this.mtpDraftingMarkerSeen) return;
    const combined = `${this.trailingTextByStream.get(streamKind) ?? ''}${chunkText}`;
    if (combined.includes(MTP_DRAFTING_MARKER)) {
      this.mtpDraftingMarkerSeen = true;
      this.trailingTextByStream.clear();
      return;
    }
    this.trailingTextByStream.set(
      streamKind,
      combined.slice(-(MTP_DRAFTING_MARKER.length - 1)),
    );
  }

  private observeEngineStderr(chunkText: string): void {
    const lines = `${this.engineStderrPartialLine}${chunkText}`.split('\n');
    this.engineStderrPartialLine = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.replace(/\r/gu, '').trim();
      if (PYTHON_EXCEPTION_LINE.test(trimmed)) this.lastEngineErrorLine = trimmed;
    }
  }
}
