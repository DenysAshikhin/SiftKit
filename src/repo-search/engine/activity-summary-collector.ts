import { z } from '../../lib/zod.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { ToolAction } from '../planner-protocol.js';
import type { TaskCommand } from '../prompts.js';

export const ActivitySummaryCategorySchema = z.enum([
  'read_files',
  'repository_searches',
  'commands',
  'edited_files',
  'tests',
  'web',
]);

export const ActivitySummaryEntrySchema = z.object({
  category: ActivitySummaryCategorySchema,
  label: z.string().min(1),
  failed: z.boolean(),
});

export const ActivitySummaryProgressEventSchema = z.object({
  kind: z.literal('activity_summary'),
  turn: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  entries: z.array(ActivitySummaryEntrySchema),
});

export type ActivitySummaryCategory = z.infer<typeof ActivitySummaryCategorySchema>;
export type ActivitySummaryEntry = z.infer<typeof ActivitySummaryEntrySchema>;
export type ActivitySummaryProgressEvent = z.infer<typeof ActivitySummaryProgressEventSchema>;

const TEST_COMMAND_PATTERNS = [
  /^npm\s+test(\s|$)/u,
  /^npm\s+run\s+test(\s|$)/u,
  /^node\s+.*run-tests\.js/u,
  /^npx\s+vitest(\s|$)/u,
  /^npx\s+jest(\s|$)/u,
  /^pytest(\s|$)/u,
  /^cargo\s+test(\s|$)/u,
  /^go\s+test(\s|$)/u,
];

function isTestCommand(command: string): boolean {
  const trimmed = command.trim();
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function classifyToolName(toolName: string): ActivitySummaryCategory | null {
  switch (toolName) {
    case 'read':
      return 'read_files';
    case 'grep':
    case 'find':
    case 'ls':
      return 'repository_searches';
    case 'git':
      return 'repository_searches';
    case 'write':
    case 'edit':
      return 'edited_files';
    case 'web_search':
    case 'web_fetch':
      return 'web';
    default:
      return null;
  }
}

function extractLabel(toolName: string, action: ToolAction): string {
  const reader = new JsonRecordReader(action.args);
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    return reader.optionalString('path') || 'unknown';
  }
  if (toolName === 'web_search' || toolName === 'web_fetch') {
    return reader.optionalString('query') || 'web';
  }
  return reader.optionalString('command') || toolName;
}

function classifyEntry(toolName: string, action: ToolAction, command: TaskCommand): ActivitySummaryEntry {
  const category = classifyToolName(toolName) ?? (isTestCommand(command.command) ? 'tests' : 'commands');
  const label = extractLabel(toolName, action);
  const failed = !command.safe || command.exitCode === null || command.exitCode !== 0;
  return { category, label, failed };
}

export class ActivitySummaryCollector {
  private window: ActivitySummaryEntry[] = [];

  recordBatch(_turn: number, actions: readonly ToolAction[], commands: readonly TaskCommand[]): void {
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const command = commands[i];
      if (command === undefined) {
        continue;
      }
      const toolName = String(action.tool_name || '').trim().toLowerCase();
      this.window.push(classifyEntry(toolName, action, command));
    }
  }

  takeSummary(turn: number, maxTurns: number): ActivitySummaryProgressEvent | null {
    if (turn % 10 !== 0) {
      return null;
    }
    const unique = this.deduplicate(this.window);
    this.window = [];
    return {
      kind: 'activity_summary',
      turn,
      maxTurns,
      entries: unique,
    };
  }

  private deduplicate(entries: ActivitySummaryEntry[]): ActivitySummaryEntry[] {
    const seen = new Map<string, ActivitySummaryEntry>();
    for (const entry of entries) {
      const key = `${entry.category}:${entry.label}`;
      const existing = seen.get(key);
      if (existing === undefined || entry.failed) {
        seen.set(key, entry);
      }
    }
    return [...seen.values()];
  }
}