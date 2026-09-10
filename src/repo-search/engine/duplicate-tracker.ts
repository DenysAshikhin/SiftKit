export const DUPLICATE_FORCE_THRESHOLD = 5;

export type DuplicateClassification = {
  isExactDuplicate: boolean;
  isSemanticDuplicate: boolean;
  duplicateFingerprint: string;
};

export type DuplicateRegistration = {
  count: number;
  /** The tool call whose result the repeat should overwrite, or null when a new one must be appended. */
  activeReplayToolCallId: string | null;
};

export function buildDuplicateFingerprint(toolName: string, normalizedKey: string, fingerprint: string): string {
  return fingerprint || `${toolName}|${normalizedKey}`;
}

export class DuplicateTracker {
  private readonly successfulNormalizedKeys = new Set<string>();
  private readonly successfulFingerprints = new Set<string>();
  private replayFingerprint: string | null = null;
  private replayCount = 0;
  private replayToolCallId: string | null = null;

  classify(options: {
    toolName: string;
    normalizedKey: string;
    fingerprint: string;
    rejected: boolean;
  }): DuplicateClassification {
    const isExactDuplicate = this.successfulNormalizedKeys.has(options.normalizedKey);
    const isSemanticDuplicate = Boolean(
      !isExactDuplicate
      && !options.rejected
      && options.fingerprint
      && this.successfulFingerprints.has(options.fingerprint),
    );
    return {
      isExactDuplicate,
      isSemanticDuplicate,
      duplicateFingerprint: buildDuplicateFingerprint(options.toolName, options.normalizedKey, options.fingerprint),
    };
  }

  /** The call a repeat would overwrite; the transcript still decides whether it survived compaction. */
  get replayAnchorToolCallId(): string | null {
    return this.replayToolCallId;
  }

  registerDuplicate(duplicateFingerprint: string, anchorAvailable: boolean): DuplicateRegistration {
    const isActiveReplay = this.replayFingerprint === duplicateFingerprint
      && anchorAvailable
      && this.replayToolCallId !== null;
    this.replayFingerprint = duplicateFingerprint;
    this.replayCount = isActiveReplay ? this.replayCount + 1 : 2;
    return {
      count: this.replayCount,
      activeReplayToolCallId: isActiveReplay ? this.replayToolCallId : null,
    };
  }

  setReplayToolCallId(toolCallId: string): void {
    this.replayToolCallId = toolCallId;
  }

  shouldForceFinish(): boolean {
    return this.replayCount >= DUPLICATE_FORCE_THRESHOLD;
  }

  recordSuccess(normalizedKey: string, fingerprint: string | null): void {
    this.replayFingerprint = null;
    this.replayCount = 0;
    this.replayToolCallId = null;
    this.successfulNormalizedKeys.add(normalizedKey);
    if (fingerprint) {
      this.successfulFingerprints.add(fingerprint);
    }
  }

  /**
   * A tool that changed the working tree makes every earlier query answerable differently, so the
   * accumulated successes stop being evidence that a repeat is pointless.
   */
  forgetSuccesses(): void {
    this.successfulNormalizedKeys.clear();
    this.successfulFingerprints.clear();
  }
}
