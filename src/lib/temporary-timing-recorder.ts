import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

export type TemporaryTimingKind = 'repo-search' | 'summary';
export type TemporaryTimingValue = string | number | boolean | null;
export type TemporaryTimingMetadata = Record<string, TemporaryTimingValue>;

type TemporaryTimingEvent = {
  label: string;
  startedAtMs: number;
  durationMs: number;
  metadata: TemporaryTimingMetadata;
};

type TemporaryTimingSummary = {
  label: string;
  calls: number;
  totalMs: number;
  maxMs: number;
};

const MAX_RECORDED_EVENTS = 1000;

function isTraceEnabled(): boolean {
  const value = String(process.env.SIFTKIT_TEMP_TIMING_TRACE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function roundDurationMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'trace';
}

export class TemporaryTimingSpan {
  private ended = false;

  constructor(
    private readonly recorder: TemporaryTimingRecorder,
    private readonly label: string,
    private readonly startedAtMs: number,
    private readonly metadata: TemporaryTimingMetadata,
  ) {}

  end(metadata: TemporaryTimingMetadata = {}): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.recorder.record(this.label, this.startedAtMs, performance.now() - this.startedAtMs, {
      ...this.metadata,
      ...metadata,
    });
  }
}

export class TemporaryTimingRecorder {
  private readonly startedAtUtc = new Date().toISOString();
  private readonly startedAtWallMs = Date.now();
  private readonly startedAtMs = performance.now();
  private readonly events: TemporaryTimingEvent[] = [];
  private readonly summaries = new Map<string, TemporaryTimingSummary>();

  constructor(
    private readonly kind: TemporaryTimingKind,
    private readonly requestId: string,
    private readonly filePath: string,
    private readonly metadata: TemporaryTimingMetadata = {},
  ) {}

  getFilePath(): string {
    return this.filePath;
  }

  start(label: string, metadata: TemporaryTimingMetadata = {}): TemporaryTimingSpan {
    return new TemporaryTimingSpan(this, label, performance.now(), metadata);
  }

  record(
    label: string,
    startedAtMs: number,
    durationMs: number,
    metadata: TemporaryTimingMetadata = {},
  ): void {
    const normalizedDurationMs = roundDurationMs(durationMs);
    const summary = this.summaries.get(label) || {
      label,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
    };
    summary.calls += 1;
    summary.totalMs = roundDurationMs(summary.totalMs + normalizedDurationMs);
    summary.maxMs = Math.max(summary.maxMs, normalizedDurationMs);
    this.summaries.set(label, summary);

    if (this.events.length < MAX_RECORDED_EVENTS) {
      this.events.push({
        label,
        startedAtMs: roundDurationMs(startedAtMs - this.startedAtMs),
        durationMs: normalizedDurationMs,
        metadata,
      });
    }
  }

  async flush(options: { status: 'completed' | 'failed'; metadata?: TemporaryTimingMetadata }): Promise<void> {
    const finishedAtWallMs = Date.now();
    const payload = {
      kind: this.kind,
      requestId: this.requestId,
      status: options.status,
      startedAtUtc: this.startedAtUtc,
      finishedAtUtc: new Date(finishedAtWallMs).toISOString(),
      wallDurationMs: Math.max(0, finishedAtWallMs - this.startedAtWallMs),
      tracePath: this.filePath,
      metadata: {
        ...this.metadata,
        ...(options.metadata ?? {}),
      },
      events: this.events,
      summary: Array.from(this.summaries.values()).sort((left, right) => right.totalMs - left.totalMs),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

export function createTemporaryTimingRecorderFromEnv(options: {
  kind: TemporaryTimingKind;
  requestId: string;
  metadata?: TemporaryTimingMetadata;
}): TemporaryTimingRecorder | null {
  if (!isTraceEnabled()) {
    return null;
  }
  const explicitFile = String(process.env.SIFTKIT_TEMP_TIMING_TRACE_FILE || '').trim();
  const filePath = explicitFile
    ? path.resolve(explicitFile)
    : path.join(
      path.resolve(String(process.env.SIFTKIT_TEMP_TIMING_TRACE_DIR || path.join(os.tmpdir(), 'siftkit-temp-timing'))),
      `${sanitizePathPart(options.kind)}-${sanitizePathPart(options.requestId)}-${Date.now()}.json`,
    );
  return new TemporaryTimingRecorder(options.kind, options.requestId, filePath, options.metadata ?? {});
}
