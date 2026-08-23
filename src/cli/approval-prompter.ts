import { createInterface } from 'node:readline';
import type { ApprovalRequestProgressEvent } from '../repo-search/types.js';
import {
  CLIENT_ABORT_MESSAGE,
  type ApprovalDecision,
} from '../repo-search/engine/approval-gate.js';

/** Anything that can answer an approval request: TTY prompter or store-backed prompter. */
export type ApprovalPrompter = {
  promptDecision(event: ApprovalRequestProgressEvent): Promise<ApprovalDecision>;
};

/** Interactive terminal prompt for repo-search approval_request frames. */
export class CliApprovalPrompter implements ApprovalPrompter {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(options: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) {
    this.input = options.input;
    this.output = options.output;
  }

  async promptDecision(event: ApprovalRequestProgressEvent): Promise<ApprovalDecision> {
    // An approval carries no maxTurns, so the turn stands alone.
    this.output.write(`repo-search t${event.turn} wants to run: ${event.command || event.toolName}\n`);
    if (event.reviewPayload !== undefined) {
      this.output.write(`Proposed edit/write payload:\n${event.reviewPayload}\n`);
    }

    // readline's async iterator buffers lines internally, so input that arrives
    // before a prompt is awaited is not lost.
    const rl = createInterface({ input: this.input, output: this.output });
    const lines = rl[Symbol.asyncIterator]();
    // null signals the input stream closed (EOF); the caller treats that as abort
    // rather than spinning on an endless empty prompt.
    const nextLine = async (prompt: string): Promise<string | null> => {
      this.output.write(prompt);
      const next = await lines.next();
      return next.done ? null : next.value;
    };

    try {
      for (;;) {
        const answer = await nextLine('  [a]pprove  [d]eny  a[b]ort > ');
        if (answer === null) {
          return { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
        }
        const key = answer.trim().toLowerCase();
        if (key === 'a') {
          return { kind: 'approve' };
        }
        if (key === 'b') {
          return { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
        }
        if (key === 'd') {
          const reason = await nextLine('  reason (enter to skip) > ');
          return { kind: 'deny', reason: (reason ?? '').trim() };
        }
      }
    } finally {
      rl.close();
    }
  }
}
