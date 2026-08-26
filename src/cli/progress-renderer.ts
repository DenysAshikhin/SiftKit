import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { formatInteger, formatPromptTokensField, formatTimestamp } from '../lib/text-format.js';
import { ActivitySummaryProgressEventSchema } from '../repo-search/engine/activity-summary-collector.js';
import {
  LlmEndProgressEventSchema,
  LlmStartProgressEventSchema,
  ToolResultProgressEventSchema,
} from '../repo-search/types.js';

const SKIPPED_KINDS = new Set(['thinking', 'answer']);

/** Token counts are only rendered off a parsed event, so a missing field falls back to the bare kind line. */
const LlmProgressEventSchema = z.union([LlmStartProgressEventSchema, LlmEndProgressEventSchema]);

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
      : new WarningOnlyProgressRenderer(stderr, opLabel);
  }

  render(event: JsonObject): void {
    const reader = new JsonRecordReader(event);
    const kind = reader.optionalString('kind') || '';
    if (!kind || SKIPPED_KINDS.has(kind)) {
      return;
    }
    const line = this.describe(kind, reader, event);
    if (line) {
      this.stderr.write(`${formatTimestamp()} ${this.opLabel} ${line}\n`);
    }
  }

  private describe(kind: string, reader: JsonRecordReader, event: JsonObject): string {
    const turn = reader.number('turn');
    const maxTurns = reader.number('maxTurns');
    const turnPrefix = turn !== null && maxTurns !== null ? `t${turn}/${maxTurns} ` : '';
    if (kind === 'lock_wait') {
      const queueLength = reader.number('queueLength') ?? 0;
      const seconds = Math.round((reader.number('elapsedMs') ?? 0) / 1_000);
      return `waiting for model lock (${queueLength} queued, ${seconds}s)`;
    }
    if (kind === 'context_warning') {
      return `warning: ${reader.optionalString('warningText') || 'startup context was skipped'}`;
    }
    if (kind === 'tool_start') {
      return `${turnPrefix}${reader.optionalString('command') || ''}`.trim();
    }
    if (kind === 'tool_result') {
      const result = ToolResultProgressEventSchema.safeParse(event);
      if (result.success) {
        return `${turnPrefix}done exit=${result.data.exitCode} ${formatInteger(result.data.outputTokens)}tok`.trim();
      }
      return `${turnPrefix}${kind}`.trim();
    }
    if (kind === 'progress_update') {
      return `${turnPrefix}progress "${reader.optionalString('progressText') || ''}"`.trim();
    }
    if (kind === 'llm_start' || kind === 'llm_end') {
      const result = LlmProgressEventSchema.safeParse(event);
      if (result.success) {
        const promptField = formatPromptTokensField(result.data.promptTokenCount, result.data.thinkingTokenCount);
        return `${turnPrefix}${kind} ${promptField}`.trim();
      }
      return `${turnPrefix}${kind}`.trim();
    }
    if (kind === 'approval_auto') {
      const verdict = reader.optionalString('verdict') || '';
      const reason = reader.optionalString('reason') || '';
      return `${turnPrefix}auto-approval ${verdict}: ${reader.optionalString('toolName') || ''} — ${reason}`.trim();
    }
    if (kind === 'activity_summary') {
      const result = ActivitySummaryProgressEventSchema.safeParse(event);
      if (result.success) {
        return this.formatActivitySummary(result.data);
      }
    }
    return `${turnPrefix}${kind}`.trim();
  }

  private formatActivitySummary(event: { turn: number; maxTurns: number; entries: { category: string; label: string; failed: boolean }[] }): string {
    const lines: string[] = [`--- activity summary t${event.turn}/${event.maxTurns} ---`];
    const grouped = new Map<string, { label: string; failed: boolean }[]>();
    for (const entry of event.entries) {
      const bucket = grouped.get(entry.category) ?? [];
      bucket.push({ label: entry.label, failed: entry.failed });
      grouped.set(entry.category, bucket);
    }
    const categoryOrder = ['read_files', 'repository_searches', 'commands', 'edited_files', 'tests', 'web'];
    for (const category of categoryOrder) {
      const items = grouped.get(category);
      if (!items || items.length === 0) {
        continue;
      }
      const count = items.length;
      const labels = items.map((item) => `${item.label}${item.failed ? ' [failed]' : ''}`).join(', ');
      lines.push(`  ${category} (${count}): ${labels}`);
    }
    return lines.join('\n');
  }
}

/** Explicit no-op renderer for machine-readable and non-rendering callers. */
export class SilentProgressRenderer extends CliProgressRenderer {
  override render(_event: JsonObject): void {}
}

export class WarningOnlyProgressRenderer extends CliProgressRenderer {
  override render(event: JsonObject): void {
    const kind = new JsonRecordReader(event).optionalString('kind');
    if (kind === 'context_warning' || kind === 'activity_summary') {
      super.render(event);
    }
  }
}
