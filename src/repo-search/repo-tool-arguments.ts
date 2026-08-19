import { MAX_RUN_TIMEOUT_MS } from '../lib/powershell.js';
import { z } from '../lib/zod.js';

const PATH_CONTROL_ESCAPES = /[\t\n\r\b\f]/gu;
const COMMAND_PATH_CONTROL_ESCAPES = /(?<=\S)[\t\r\b\f](?=\S)/gu;
const CONTROL_ESCAPE_LETTERS: Record<string, string> = {
  '\t': 't',
  '\n': 'n',
  '\r': 'r',
  '\b': 'b',
  '\f': 'f',
};

function restoreWindowsSeparators(value: string, kind: 'path' | 'command'): string {
  return value.replace(kind === 'path' ? PATH_CONTROL_ESCAPES : COMMAND_PATH_CONTROL_ESCAPES, (match) => {
    const letter = CONTROL_ESCAPE_LETTERS[match];
    return letter === undefined ? match : `\\${letter}`;
  });
}

export function restoreModelCommandSeparators(value: string): string {
  return restoreWindowsSeparators(value, 'command');
}

const RequiredTrimmedTextSchema = z.string().trim().min(1);
const PathSchema = RequiredTrimmedTextSchema.transform((value) => restoreWindowsSeparators(value, 'path'));
const CommandSchema = RequiredTrimmedTextSchema.transform(restoreModelCommandSeparators);
const PositiveIntegerSchema = z.number().int().positive();
const VerbatimNonEmptyTextSchema = z.string().min(1);

export const RUN_OUTPUT_MODES = ['auto', 'full'] as const;
export const RunOutputModeSchema = z.enum(RUN_OUTPUT_MODES);
export type RunOutputMode = z.infer<typeof RunOutputModeSchema>;

const ReadToolArgsSchema = z.object({
  path: PathSchema,
  offset: PositiveIntegerSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const GrepToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: PathSchema.optional(),
  glob: RequiredTrimmedTextSchema.optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().int().nonnegative().optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const FindToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: PathSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const LsToolArgsSchema = z.object({
  path: PathSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const WriteToolArgsSchema = z.object({
  path: PathSchema,
  content: VerbatimNonEmptyTextSchema,
}).strict();

const EditReplacementSchema = z.object({
  oldText: VerbatimNonEmptyTextSchema,
  newText: z.string(),
}).strict();

const EditToolArgsSchema = z.object({
  path: PathSchema,
  edits: z.array(EditReplacementSchema).min(1),
}).strict();

const RunToolArgsSchema = z.object({
  command: CommandSchema,
  timeoutMs: PositiveIntegerSchema.max(MAX_RUN_TIMEOUT_MS).optional(),
  outputMode: RunOutputModeSchema.optional(),
}).strict();

const WebSearchToolArgsSchema = z.object({
  query: RequiredTrimmedTextSchema,
  timeFilter: z.enum(['day', 'week', 'month', 'year']).optional(),
}).strict();

const WebFetchToolArgsSchema = z.object({
  url: RequiredTrimmedTextSchema,
}).strict();

export const RepoNativeToolCallSchema = z.discriminatedUnion('toolName', [
  z.object({ toolName: z.literal('read'), args: ReadToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('grep'), args: GrepToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('find'), args: FindToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('ls'), args: LsToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('write'), args: WriteToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('edit'), args: EditToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('run'), args: RunToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_search'), args: WebSearchToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_fetch'), args: WebFetchToolArgsSchema }).strict(),
]);

export type RepoNativeToolCall = z.infer<typeof RepoNativeToolCallSchema>;
