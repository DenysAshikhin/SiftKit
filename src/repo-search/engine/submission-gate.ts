/** Code's verdict on a finishing answer: accept it as the run's output, or return feedback the model keeps working from. */
export type SubmissionVerdict = { kind: 'accept'; output: string } | { kind: 'reject'; message: string };

/** Judges each finishing answer before the run accepts it; a rejection keeps the same conversation going. */
export interface SubmissionGate {
  review(answer: string): Promise<SubmissionVerdict>;
}
