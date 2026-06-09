export const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
export const FORCED_FINISH_MAX_ATTEMPTS = 3;
export const FORCED_FINISH_MODE_MESSAGE = 'Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.';

export type ForcedFinishAttempt = {
  attemptsRemaining: number;
  rejectionReason: string;
  countdownText: string;
  exhausted: boolean;
};

export type ZeroOutputObservation = {
  zeroOutputStreak: number;
  remainingBeforeForce: number;
  warningText: string;
  activated: boolean;
};

export class ForcedFinishController {
  private zeroOutputStreak = 0;
  private attemptsRemaining = 0;

  isActive(): boolean {
    return this.attemptsRemaining > 0;
  }

  activateFromStagnation(): string {
    this.attemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
    return FORCED_FINISH_MODE_MESSAGE;
  }

  consumeAttempt(): ForcedFinishAttempt {
    this.attemptsRemaining = Math.max(this.attemptsRemaining - 1, 0);
    return {
      attemptsRemaining: this.attemptsRemaining,
      rejectionReason: `Forced finish mode active. Return a finish action now. Attempts remaining: ${this.attemptsRemaining}.`,
      countdownText: `Forced finish attempts remaining: ${this.attemptsRemaining}. Return a finish action now.`,
      exhausted: this.attemptsRemaining === 0,
    };
  }

  recordToolOutput(baseOutputLength: number): ZeroOutputObservation {
    if (baseOutputLength === 0) {
      this.zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - this.zeroOutputStreak, 0);
      const warningText = remainingBeforeForce > 0
        ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
        : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`;
      const activated = remainingBeforeForce === 0 && this.attemptsRemaining === 0;
      if (activated) {
        this.attemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
      }
      return { zeroOutputStreak: this.zeroOutputStreak, remainingBeforeForce, warningText, activated };
    }
    this.zeroOutputStreak = 0;
    return { zeroOutputStreak: 0, remainingBeforeForce: ZERO_OUTPUT_FORCE_THRESHOLD, warningText: '', activated: false };
  }
}
