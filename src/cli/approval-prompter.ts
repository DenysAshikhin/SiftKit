import { createInterface } from 'node:readline';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ApprovalDecision } from '../repo-search/engine/approval-gate.js';

/** Interactive terminal prompt for repo-search approval_request frames. */
export class CliApprovalPrompter {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(options: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) {
    this.input = options.input;
    this.output = options.output;
  }

  async promptDecision(event: JsonObject): Promise<ApprovalDecision> {
    const reader = new JsonRecordReader(event);
    const turn = reader.number('turn');
    const maxTurns = reader.number('maxTurns');
    const turnLabel = turn !== null && maxTurns !== null ? `t${turn}/${maxTurns} ` : '';
    const command = reader.optionalString('command') || reader.optionalString('toolName') || '<unknown>';
    this.output.write(`repo-search ${turnLabel}wants to run: ${command}\n`);

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
          return { kind: 'abort' };
        }
        const key = answer.trim().toLowerCase();
        if (key === 'a') {
          return { kind: 'approve' };
        }
        if (key === 'b') {
          return { kind: 'abort' };
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
