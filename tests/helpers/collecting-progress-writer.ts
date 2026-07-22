import { ProgressWriter } from '../../src/lib/progress-writer.js';

export class CollectingProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  public readonly events: TEvent[] = [];

  get enabled(): boolean {
    return true;
  }

  write(event: TEvent): void {
    this.events.push(event);
  }
}
