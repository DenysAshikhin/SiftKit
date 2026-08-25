import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from '../lib/powershell.js';
import { z } from '../lib/zod.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from './engine/runtime-profile.js';

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

export const ReadToolArgsSchema = z.object({
  path: PathSchema.describe('Path to the file to read, relative to the repository root'),
  offset: PositiveIntegerSchema.describe('Line number to start reading from (1-indexed)').optional(),
  limit: PositiveIntegerSchema.describe('Maximum number of lines to read').optional(),
}).strict();

export const GrepToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema.describe('Search pattern (regex, or literal string when literal=true)'),
  path: PathSchema.describe('Directory or file to search (default: repository root)').optional(),
  glob: RequiredTrimmedTextSchema.describe("Filter files by glob pattern, e.g. '*.ts' or 'src/**/*.test.ts'").optional(),
  ignoreCase: z.boolean().describe('Case-insensitive search (default: true)').optional(),
  literal: z.boolean().describe('Treat pattern as a literal string instead of a regex (default: false)').optional(),
  context: z.number().int().nonnegative().describe('Number of lines to show before and after each match (default: 0)').optional(),
  limit: PositiveIntegerSchema.describe('Maximum number of matches to return (default: 100)').optional(),
}).strict();

export const FindToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema.describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.test.ts'"),
  path: PathSchema.describe('Directory to search in (default: repository root)').optional(),
  limit: PositiveIntegerSchema.describe('Maximum number of results (default: 1000)').optional(),
}).strict();

export const LsToolArgsSchema = z.object({
  path: PathSchema.describe('Directory to list (default: repository root)').optional(),
  limit: PositiveIntegerSchema.describe('Maximum number of entries to return (default: 500)').optional(),
}).strict();

export const WriteToolArgsSchema = z.object({
  path: PathSchema.describe('Path to the file to write, relative to the repository root'),
  content: VerbatimNonEmptyTextSchema.describe('Content to write to the file'),
}).strict();

const EditReplacementSchema = z.object({
  oldText: VerbatimNonEmptyTextSchema.describe('Exact text for one targeted replacement. Must be unique in the original file and must not overlap any other edits[].oldText in the same call.'),
  newText: z.string().describe('Replacement text for this targeted edit.'),
}).strict();

export const EditToolArgsSchema = z.object({
  path: PathSchema.describe('Path to the file to edit, relative to the repository root'),
  edits: z.array(EditReplacementSchema)
    .min(1)
    .describe('One or more targeted replacements. Each edit is matched against the original file, not incrementally.'),
}).strict();

export const RunToolArgsSchema = z.object({
  command: CommandSchema.describe('Command to execute'),
  timeoutMs: PositiveIntegerSchema.max(MAX_RUN_TIMEOUT_MS)
    .describe(`Timeout in milliseconds (optional, default ${DEFAULT_RUN_TIMEOUT_MS}, max ${MAX_RUN_TIMEOUT_MS})`)
    .optional(),
  outputMode: RunOutputModeSchema
    .describe(`Output shaping. auto (default) keeps a curated final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines for test/build/lint/typecheck commands - use it for those. full returns raw output; on such commands a first full request is served as auto, and only an immediate identical retry with full returns raw output.`)
    .optional(),
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

export const WebSearchToolArgsSchema = z.object({
  query: RequiredTrimmedTextSchema,
  timeFilter: z.enum(['day', 'week', 'month', 'year']).optional(),
}).strict();

export const WebFetchToolArgsSchema = z.object({
  url: RequiredTrimmedTextSchema,
}).strict();

export const REPO_TOOL_ARGUMENT_SCHEMAS = {
  read: ReadToolArgsSchema,
  grep: GrepToolArgsSchema,
  find: FindToolArgsSchema,
  ls: LsToolArgsSchema,
  write: WriteToolArgsSchema,
  edit: EditToolArgsSchema,
  run: RunToolArgsSchema,
  git: GitToolArgsSchema,
  web_search: WebSearchToolArgsSchema,
  web_fetch: WebFetchToolArgsSchema,
} as const;

export type RepoToolName = keyof typeof REPO_TOOL_ARGUMENT_SCHEMAS;

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
