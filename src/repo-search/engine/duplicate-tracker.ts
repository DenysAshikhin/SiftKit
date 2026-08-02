export const DUPLICATE_FORCE_THRESHOLD = 5;

export type DuplicateClassification = {
  isExactDuplicate: boolean;
  isSemanticDuplicate: boolean;
  duplicateFingerprint: string;
};

export type DuplicateRegistration = {
  count: number;
  activeReplayMessageIndex: number | null;
};

export function buildDuplicateFingerprint(toolName: string, normalizedKey: string, fingerprint: string): string {
  return fingerprint || `${toolName}|${normalizedKey}`;
}

export class DuplicateTracker {
  private readonly successfulNormalizedKeys = new Set<string>();
  private readonly successfulFingerprints = new Set<string>();
  private replayFingerprint: string | null = null;
  private replayCount = 0;
  private replayToolMessageIndex = -1;

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

  registerDuplicate(duplicateFingerprint: string, messageCount: number): DuplicateRegistration {
    const isActiveReplay = this.replayFingerprint === duplicateFingerprint
      && this.replayToolMessageIndex >= 0
      && this.replayToolMessageIndex < messageCount;
    this.replayFingerprint = duplicateFingerprint;
    this.replayCount = isActiveReplay ? this.replayCount + 1 : 2;
    return {
      count: this.replayCount,
      activeReplayMessageIndex: isActiveReplay ? this.replayToolMessageIndex : null,
    };
  }

  setReplayToolMessageIndex(index: number): void {
    this.replayToolMessageIndex = index;
  }

  shouldForceFinish(): boolean {
    return this.replayCount >= DUPLICATE_FORCE_THRESHOLD;
  }

  recordSuccess(normalizedKey: string, fingerprint: string | null): void {
    this.replayFingerprint = null;
    this.replayCount = 0;
    this.replayToolMessageIndex = -1;
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
