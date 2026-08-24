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
const GitRefSchema = RequiredTrimmedTextSchema
  .refine((value) => !value.startsWith('-'), 'Git refs must not begin with "-".')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Git refs must not contain ASCII control characters.');

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

export const GitToolArgsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({
    operation: z.literal('log'),
    limit: PositiveIntegerSchema.optional(),
    ref: GitRefSchema.optional(),
    path: PathSchema.optional(),
    patches: z.boolean().optional(),
  }).strict(),
  z.object({
    operation: z.literal('show'),
    ref: GitRefSchema,
    path: PathSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('diff'),
    base: GitRefSchema.optional(),
    target: GitRefSchema.optional(),
    path: PathSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('blame'),
    path: PathSchema,
    startLine: PositiveIntegerSchema.optional(),
    endLine: PositiveIntegerSchema.optional(),
  }).strict().superRefine((args, context) => {
    if ((args.startLine === undefined) !== (args.endLine === undefined)) {
      context.addIssue({ code: 'custom', message: 'startLine and endLine must be supplied together.' });
    } else if (args.startLine !== undefined && args.endLine !== undefined && args.startLine > args.endLine) {
      context.addIssue({ code: 'custom', message: 'startLine must not exceed endLine.' });
    }
  }),
  z.object({
    operation: z.literal('grep'),
    pattern: RequiredTrimmedTextSchema,
    ref: GitRefSchema.optional(),
    path: PathSchema.optional(),
    ignoreCase: z.boolean().optional(),
    limit: PositiveIntegerSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('ls_files'),
    path: PathSchema.optional(),
    limit: PositiveIntegerSchema.optional(),
  }).strict(),
]);

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
  z.object({ toolName: z.literal('git'), args: GitToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_search'), args: WebSearchToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_fetch'), args: WebFetchToolArgsSchema }).strict(),
]);

export type RepoNativeToolCall = z.infer<typeof RepoNativeToolCallSchema>;
export type ReadToolArgs = z.infer<typeof ReadToolArgsSchema>;
export type GrepToolArgs = z.infer<typeof GrepToolArgsSchema>;
export type FindToolArgs = z.infer<typeof FindToolArgsSchema>;
export type LsToolArgs = z.infer<typeof LsToolArgsSchema>;
export type WriteToolArgs = z.infer<typeof WriteToolArgsSchema>;
export type EditToolArgs = z.infer<typeof EditToolArgsSchema>;
export type RunToolArgs = z.infer<typeof RunToolArgsSchema>;
export type GitToolArgs = z.infer<typeof GitToolArgsSchema>;
export type WebSearchToolArgs = z.infer<typeof WebSearchToolArgsSchema>;
export type WebFetchToolArgs = z.infer<typeof WebFetchToolArgsSchema>;
