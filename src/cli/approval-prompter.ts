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

    // A persistent line listener with a queue: lines that arrive before a prompt
    // is awaited are buffered rather than lost (successive readline.question calls
    // drop such lines).
    const rl = createInterface({ input: this.input, output: this.output });
    const bufferedLines: string[] = [];
    let waiting: ((line: string) => void) | null = null;
    const onLine = (line: string): void => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(line);
        return;
      }
      bufferedLines.push(line);
    };
    rl.on('line', onLine);
    const nextLine = (prompt: string): Promise<string> => {
      this.output.write(prompt);
      return new Promise((resolve) => {
        const buffered = bufferedLines.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        waiting = resolve;
      });
    };

    try {
      for (;;) {
        const answer = (await nextLine('  [a]pprove  [d]eny  a[b]ort > ')).trim().toLowerCase();
        if (answer === 'a') {
          return { kind: 'approve' };
        }
        if (answer === 'b') {
          return { kind: 'abort' };
        }
        if (answer === 'd') {
          const reason = (await nextLine('  reason (enter to skip) > ')).trim();
          return { kind: 'deny', reason };
        }
      }
    } finally {
      rl.off('line', onLine);
      rl.close();
    }
  }
}
