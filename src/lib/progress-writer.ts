/** Hears that the provider produced a validated message for the run, independent of UI text delivery. */
export type InferenceActivityObserver = {
  recordActivity(): void;
};

export abstract class ProgressWriter<TEvent> implements InferenceActivityObserver {
  abstract get enabled(): boolean;
  abstract write(event: TEvent): void;

  /**
   * Whether this writer consumes per-token live-text ('thinking'/'answer')
   * events. Producers skip building them when false.
   */
  get wantsLiveText(): boolean {
    return true;
  }

  /** Provider activity for the run. Not an event: nothing is rendered, logged, or journaled. */
  recordActivity(): void {}
}

export class SilentProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  get enabled(): boolean {
    return false;
  }

  write(_event: TEvent): void {}
}
