export type ChatTurnPhaseTimestamps = {
  requestStartedAtUtc: string;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
};

export class ChatTurnPhaseTracker {
  private readonly requestStartedAtUtc: string;
  private thinkingStartedAtUtc: string | null = null;
  private thinkingEndedAtUtc: string | null = null;
  private answerStartedAtUtc: string | null = null;
  private answerEndedAtUtc: string | null = null;

  constructor(requestStartedAtUtc = new Date().toISOString()) {
    this.requestStartedAtUtc = requestStartedAtUtc;
  }

  observeThinking(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.thinkingStartedAtUtc ??= now;
    this.thinkingEndedAtUtc = now;
  }

  observeAnswer(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.answerStartedAtUtc ??= now;
    this.answerEndedAtUtc = now;
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return {
      requestStartedAtUtc: this.requestStartedAtUtc,
      thinkingStartedAtUtc: this.thinkingStartedAtUtc,
      thinkingEndedAtUtc: this.thinkingEndedAtUtc,
      answerStartedAtUtc: this.answerStartedAtUtc,
      answerEndedAtUtc: this.answerEndedAtUtc,
    };
  }
}
