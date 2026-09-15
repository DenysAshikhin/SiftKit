import { ProgressWriter } from '../../src/lib/progress-writer.js';

export class CollectingProgressWriter<TEvent extends { kind: string }> extends ProgressWriter<TEvent> {
  public readonly events: TEvent[];
  /** Provider frames observed, counted apart from events so headless activity stays visible. */
  public activity = 0;

  constructor(events: TEvent[] = [], private readonly liveText = true) {
    super();
    this.events = events;
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return this.liveText;
  }

  override recordActivity(): void {
    this.activity += 1;
  }

  write(event: TEvent): void {
    this.events.push(event);
  }

  /** Narrows to one kind so assertions read that kind's own fields without re-checking them. */
  ofKind<TKind extends TEvent['kind']>(kind: TKind): Extract<TEvent, { kind: TKind }>[] {
    return this.events.filter((event): event is Extract<TEvent, { kind: TKind }> => event.kind === kind);
  }
}
