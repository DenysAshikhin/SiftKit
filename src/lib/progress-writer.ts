export abstract class ProgressWriter<TEvent> {
  abstract get enabled(): boolean;
  abstract write(event: TEvent): void;
}

export class SilentProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  get enabled(): boolean {
    return false;
  }

  write(_event: TEvent): void {}
}
