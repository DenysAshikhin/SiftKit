import type { InferenceRunStreamKind } from '../state/inference-runs.js';
import { InferenceRunRecorder } from './inference-run-recorder.js';

const MTP_DRAFTING_MARKER = 'Using main model MTP component for drafting';

/** Tracks startup facts directly from TabbyAPI streams before asynchronous log persistence. */
export class TabbyRunRecorder extends InferenceRunRecorder {
  private readonly trailingTextByStream = new Map<InferenceRunStreamKind, string>();
  private mtpDraftingMarkerSeen = false;

  hasMtpDraftingMarker(): boolean {
    return this.mtpDraftingMarkerSeen;
  }

  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
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
}
