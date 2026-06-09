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

export class DuplicateTracker {
  private lastSuccessfulNormalizedKey: string | null = null;
  private lastSuccessfulFingerprint: string | null = null;
  private replayFingerprint: string | null = null;
  private replayCount = 0;
  private replayToolMessageIndex = -1;

  classify(options: {
    toolName: string;
    normalizedKey: string;
    fingerprint: string;
    rejected: boolean;
  }): DuplicateClassification {
    const isExactDuplicate = Boolean(
      this.lastSuccessfulNormalizedKey && options.normalizedKey === this.lastSuccessfulNormalizedKey,
    );
    const isSemanticDuplicate = Boolean(
      !isExactDuplicate
      && !options.rejected
      && options.fingerprint
      && this.lastSuccessfulFingerprint
      && options.fingerprint === this.lastSuccessfulFingerprint,
    );
    return {
      isExactDuplicate,
      isSemanticDuplicate,
      duplicateFingerprint: options.fingerprint || `${options.toolName}|${options.normalizedKey}`,
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
    this.lastSuccessfulNormalizedKey = normalizedKey;
    this.lastSuccessfulFingerprint = fingerprint;
  }
}
