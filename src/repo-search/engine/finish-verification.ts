export const FINISH_VERIFICATION_MAX_CHALLENGES = 2;
export const FINISH_VERIFICATION_CHALLENGE_MESSAGE =
  'Verification check: are you sure you finished and adhered to the task correctly? '
  + 'Re-read the task requirements. If you are certain the work is complete and verified, '
  + 'return the finish action again. If anything is incomplete, unverified, or was skipped, '
  + 'continue working with tool actions instead.';

export type FinishVerificationDecision =
  | { kind: 'challenge'; message: string; challengesIssued: number }
  | { kind: 'accept'; mode?: 'reaffirmed' | 'forced' };

/**
 * Challenges an agent run's finish before accepting it. A finish emitted while a challenge is
 * outstanding is a reaffirmation and is accepted; an executed tool action withdraws the finish
 * and re-arms the gate. After FINISH_VERIFICATION_MAX_CHALLENGES challenges the next finish is
 * accepted unchallenged, bounding the loop.
 */
export class FinishVerificationGate {
  private challengesIssued = 0;
  private awaitingReaffirmation = false;

  constructor(private readonly enabled: boolean) {}

  get issuedCount(): number {
    return this.challengesIssued;
  }

  evaluateFinish(): FinishVerificationDecision {
    if (!this.enabled) {
      return { kind: 'accept' };
    }
    if (this.awaitingReaffirmation) {
      this.awaitingReaffirmation = false;
      return { kind: 'accept', mode: 'reaffirmed' };
    }
    if (this.challengesIssued >= FINISH_VERIFICATION_MAX_CHALLENGES) {
      return { kind: 'accept', mode: 'forced' };
    }
    this.challengesIssued += 1;
    this.awaitingReaffirmation = true;
    return {
      kind: 'challenge',
      message: FINISH_VERIFICATION_CHALLENGE_MESSAGE,
      challengesIssued: this.challengesIssued,
    };
  }

  recordNonFinishAction(): void {
    this.awaitingReaffirmation = false;
  }
}
