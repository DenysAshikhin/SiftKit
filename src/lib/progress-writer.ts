export abstract class ProgressWriter<TEvent> {
  abstract get enabled(): boolean;
  abstract write(event: TEvent): void;

  /**
   * Whether this writer consumes per-token live-text ('thinking'/'answer')
   * events. Producers skip building them when false.
   */
  get wantsLiveText(): boolean {
    return true;
  }
}

export class SilentProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  get enabled(): boolean {
    return false;
  }

  write(_event: TEvent): void {}
}
