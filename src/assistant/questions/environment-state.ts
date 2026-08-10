export type QuestionEnvironmentState =
  | { readonly kind: 'unavailable' }
  | {
    readonly kind: 'available';
    readonly nowUtc: string;
    readonly localTime: string;
    readonly fullscreen: boolean;
    readonly locked: boolean;
    readonly doNotDisturb: boolean;
    readonly presenting: boolean;
    readonly excludedApplication: boolean;
    readonly secondsSinceInput: number;
  };

export interface QuestionEnvironmentStateProvider {
  read(): QuestionEnvironmentState;
}

export class UnavailableQuestionEnvironmentStateProvider
implements QuestionEnvironmentStateProvider {
  read(): QuestionEnvironmentState {
    return { kind: 'unavailable' };
  }
}
