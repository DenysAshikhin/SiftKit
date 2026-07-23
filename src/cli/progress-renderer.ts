import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { formatTimestamp } from '../lib/text-format.js';

const SKIPPED_KINDS = new Set(['thinking', 'answer']);

function formatTokens(value: number | null): string {
  return value === null ? '' : `${value.toLocaleString('en-US')}tok`;
}

/** Renders one concise stderr line for each visible operation progress event. */
export class CliProgressRenderer {
  constructor(
    private readonly stderr: NodeJS.WritableStream,
    private readonly opLabel: string,
  ) {}

  /** Per-turn stderr telemetry is opt-in on the CLI; stays silent unless requested. */
  static forCli(stderr: NodeJS.WritableStream, opLabel: string, showProgress: boolean): CliProgressRenderer {
    return showProgress
      ? new CliProgressRenderer(stderr, opLabel)
      : new SilentProgressRenderer(stderr, opLabel);
  }

  render(event: JsonObject): void {
    const reader = new JsonRecordReader(event);
    const kind = reader.optionalString('kind') || '';
    if (!kind || SKIPPED_KINDS.has(kind)) {
      return;
    }
    const line = this.describe(kind, reader);
    if (line) {
      this.stderr.write(`${formatTimestamp()} ${this.opLabel} ${line}\n`);
    }
  }

  private describe(kind: string, reader: JsonRecordReader): string {
    const turn = reader.number('turn');
    const maxTurns = reader.number('maxTurns');
    const turnPrefix = turn !== null && maxTurns !== null ? `t${turn}/${maxTurns} ` : '';
    if (kind === 'lock_wait') {
      const queueLength = reader.number('queueLength') ?? 0;
      const seconds = Math.round((reader.number('elapsedMs') ?? 0) / 1_000);
      return `waiting for model lock (${queueLength} queued, ${seconds}s)`;
    }
    if (kind === 'tool_start') {
      return `${turnPrefix}${reader.optionalString('command') || ''}`.trim();
    }
    if (kind === 'tool_result') {
      const exitCode = reader.number('exitCode');
      const outputTokens = reader.number('outputTokens');
      return `${turnPrefix}done exit=${exitCode ?? '?'} ${formatTokens(outputTokens)}`.trim();
    }
    if (kind === 'llm_start' || kind === 'llm_end') {
      return `${turnPrefix}${kind} prompt=${formatTokens(reader.number('promptTokenCount'))}`.trim();
    }
    return `${turnPrefix}${kind}`.trim();
  }
}

/** Explicit no-op renderer for machine-readable and non-rendering callers. */
export class SilentProgressRenderer extends CliProgressRenderer {
  override render(_event: JsonObject): void {}
}
