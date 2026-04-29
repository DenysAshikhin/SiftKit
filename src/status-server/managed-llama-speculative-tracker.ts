import {
  updateManagedLlamaRunSpeculativeMetrics,
  type ManagedLlamaStreamKind,
} from '../state/managed-llama-runs.js';

export type ManagedLlamaSpeculativeMetrics = {
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
};

export type ManagedLlamaSpeculativeMetricsSnapshot = {
  stdoutOffset: number;
  stderrOffset: number;
  latestSpeculativeAcceptedTokens: number | null;
  latestSpeculativeGeneratedTokens: number | null;
};

const SPECULATIVE_STATS_PATTERN = /^\s*(?:llama_decode:\s+)?statistics\s+\S+:\s+.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)/iu;
const MAX_LINE_CARRY_CHARACTERS = 4096;

export class ManagedLlamaSpeculativeMetricsTracker {
  private stdoutCharacterCount = 0;
  private stderrCharacterCount = 0;
  private latestSpeculativeAcceptedTokens: number | null = null;
  private latestSpeculativeGeneratedTokens: number | null = null;
  private readonly lineCarryByStream = new Map<ManagedLlamaStreamKind, string>();

  appendChunk(streamKind: ManagedLlamaStreamKind, chunkText: string): void {
    const normalizedChunk = String(chunkText || '');
    if (!normalizedChunk) {
      return;
    }
    if (streamKind === 'startup_script_stdout' || streamKind === 'llama_stdout') {
      this.stdoutCharacterCount += normalizedChunk.length;
    } else if (streamKind === 'startup_script_stderr' || streamKind === 'llama_stderr') {
      this.stderrCharacterCount += normalizedChunk.length;
    } else {
      return;
    }
    const text = `${this.lineCarryByStream.get(streamKind) || ''}${normalizedChunk}`;
    const lines = text.split(/\r?\n/u);
    const endsWithNewline = /\r?\n$/u.test(text);
    const completeLines = endsWithNewline ? lines : lines.slice(0, -1);
    for (const line of completeLines) {
      this.consumeLine(line);
    }
    const carry = endsWithNewline ? '' : (lines.at(-1) || '');
    this.lineCarryByStream.set(streamKind, carry.slice(Math.max(0, carry.length - MAX_LINE_CARRY_CHARACTERS)));
  }

  captureSnapshot(): ManagedLlamaSpeculativeMetricsSnapshot {
    return {
      stdoutOffset: this.stdoutCharacterCount,
      stderrOffset: this.stderrCharacterCount,
      latestSpeculativeAcceptedTokens: this.latestSpeculativeAcceptedTokens,
      latestSpeculativeGeneratedTokens: this.latestSpeculativeGeneratedTokens,
    };
  }

  getDelta(snapshot: ManagedLlamaSpeculativeMetricsSnapshot | null): ManagedLlamaSpeculativeMetrics | null {
    if (!snapshot || this.latestSpeculativeAcceptedTokens === null || this.latestSpeculativeGeneratedTokens === null) {
      return null;
    }
    if (snapshot.latestSpeculativeAcceptedTokens === null || snapshot.latestSpeculativeGeneratedTokens === null) {
      return null;
    }
    if (
      this.latestSpeculativeAcceptedTokens < snapshot.latestSpeculativeAcceptedTokens
      || this.latestSpeculativeGeneratedTokens < snapshot.latestSpeculativeGeneratedTokens
    ) {
      return null;
    }
    const delta = {
      speculativeAcceptedTokens: this.latestSpeculativeAcceptedTokens - snapshot.latestSpeculativeAcceptedTokens,
      speculativeGeneratedTokens: this.latestSpeculativeGeneratedTokens - snapshot.latestSpeculativeGeneratedTokens,
    };
    return delta.speculativeGeneratedTokens > 0 ? delta : null;
  }

  private consumeLine(line: string): void {
    const match = SPECULATIVE_STATS_PATTERN.exec(line);
    if (!match) {
      return;
    }
    const generated = Number.parseInt(match[1] || '', 10);
    const accepted = Number.parseInt(match[2] || '', 10);
    if (!Number.isFinite(generated) || !Number.isFinite(accepted)) {
      return;
    }
    this.latestSpeculativeGeneratedTokens = generated;
    this.latestSpeculativeAcceptedTokens = accepted;
  }
}

const trackerByRunId = new Map<string, ManagedLlamaSpeculativeMetricsTracker>();

export function appendManagedLlamaSpeculativeMetricsChunk(options: {
  runId: string;
  streamKind: ManagedLlamaStreamKind;
  chunkText: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    return;
  }
  let tracker = trackerByRunId.get(runId);
  if (!tracker) {
    tracker = new ManagedLlamaSpeculativeMetricsTracker();
    trackerByRunId.set(runId, tracker);
  }
  tracker.appendChunk(options.streamKind, options.chunkText);
}

export function getManagedLlamaSpeculativeMetricsTracker(runId: string): ManagedLlamaSpeculativeMetricsTracker | null {
  return trackerByRunId.get(String(runId || '').trim()) ?? null;
}

export function getManagedLlamaSpeculativeMetricsSnapshot(runId: string): ManagedLlamaSpeculativeMetricsSnapshot | null {
  return trackerByRunId.get(String(runId || '').trim())?.captureSnapshot() ?? null;
}

export function flushManagedLlamaSpeculativeMetricsTracker(runId: string): boolean {
  const normalizedRunId = String(runId || '').trim();
  const tracker = trackerByRunId.get(normalizedRunId);
  if (!tracker) {
    return false;
  }
  const snapshot = tracker.captureSnapshot();
  return updateManagedLlamaRunSpeculativeMetrics({
    runId: normalizedRunId,
    speculativeAcceptedTokens: snapshot.latestSpeculativeAcceptedTokens,
    speculativeGeneratedTokens: snapshot.latestSpeculativeGeneratedTokens,
    stdoutCharacterCount: snapshot.stdoutOffset,
    stderrCharacterCount: snapshot.stderrOffset,
  });
}

export function deleteManagedLlamaSpeculativeMetricsTracker(runId: string): void {
  trackerByRunId.delete(String(runId || '').trim());
}
