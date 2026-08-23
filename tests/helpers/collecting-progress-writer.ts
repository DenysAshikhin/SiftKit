import { ProgressWriter } from '../../src/lib/progress-writer.js';

export class CollectingProgressWriter<TEvent extends { kind: string }> extends ProgressWriter<TEvent> {
  public readonly events: TEvent[];

  constructor(events: TEvent[] = []) {
    super();
    this.events = events;
  }

  get enabled(): boolean {
    return true;
  }

  write(event: TEvent): void {
    this.events.push(event);
  }

  /** Narrows to one kind so assertions read that kind's own fields without re-checking them. */
  ofKind<TKind extends TEvent['kind']>(kind: TKind): Extract<TEvent, { kind: TKind }>[] {
    return this.events.filter((event): event is Extract<TEvent, { kind: TKind }> => event.kind === kind);
  }
}
