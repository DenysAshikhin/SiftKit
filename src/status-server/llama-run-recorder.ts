import { InferenceRunRecorder } from './inference-run-recorder.js';
import { appendManagedLlamaSpeculativeMetricsChunk } from './managed-llama-speculative-tracker.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';

/**
 * llama.cpp reports speculative-decode acceptance only in its stdout/stderr, and only in the
 * raw stream before the storage filter drops the request echo. Scrape it on the way past.
 */
export class LlamaRunRecorder extends InferenceRunRecorder {
  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: this.runId,
      streamKind,
      chunkText,
    });
  }
}
