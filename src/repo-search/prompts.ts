import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { ImageDataUrlSchema, ImageMetadataSchema, ToolActivityKindSchema, ToolActivitySubjectSchema } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { RUN_SHELL_LABEL } from '../lib/powershell.js';
import {
  EXPOSED_REPO_TOOL_NAMES,
  INTERACTIVE_REPO_TOOL_NAMES,
} from '../planner-protocol/repo-search.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import type { IgnorePolicy } from './command-safety.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from './engine/runtime-profile.js';
import type { PresetSystemContext } from '../preset-system-context.js';

// ---------------------------------------------------------------------------
// Repo file scanner (gitignore-aware, no external dependencies)
// ---------------------------------------------------------------------------

const SCAN_MAX_FILES = 3000;

const NON_CODE_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.tif',
  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  // Audio / Video
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov', '.flv',
  // Archives / binaries
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.jar', '.war', '.ear', '.class',
  '.wasm',
  // Data / model files
  '.dat', '.db', '.sqlite', '.sqlite3',
  '.parquet', '.arrow', '.feather',
  '.onnx', '.pb', '.pt', '.pth', '.safetensors', '.gguf',
  // Documents / misc
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pom',
  // Logs
  '.log',
  // Map / tile data
  '.pbf', '.mbtiles',
]);

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

type ScanResult = {
  codeFiles: string[];
  nonCodeCounts: Map<string, Map<string, number>>; // dir -> ext -> count
};

function scanRepoFilesRaw(repoRoot: string, ignorePolicy: IgnorePolicy): ScanResult {
  const codeFiles: string[] = [];
  const nonCodeCounts = new Map<string, Map<string, number>>();
  const ignoredPaths = ignorePolicy.paths ?? [];

  function walk(dir: string, relBase: string): void {
    if (codeFiles.length >= SCAN_MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (codeFiles.length >= SCAN_MAX_FILES) return;
      if (ignorePolicy.namesLower.has(entry.name.toLowerCase())) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (ignoredPaths.some((p) => relPath === p || relPath.startsWith(`${p}/`))) continue;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        const ext = getExtension(entry.name);
        if (ext && NON_CODE_EXTENSIONS.has(ext)) {
          const dirKey = relBase || '.';
          let dirCounts = nonCodeCounts.get(dirKey);
          if (!dirCounts) {
            dirCounts = new Map<string, number>();
            nonCodeCounts.set(dirKey, dirCounts);
          }
          dirCounts.set(ext, (dirCounts.get(ext) ?? 0) + 1);
        } else {
          codeFiles.push(relPath);
        }
      }
    }
  }

  walk(repoRoot, '');
  return { codeFiles, nonCodeCounts };
}

/**
 * Collapse per-leaf-directory counts up to a summary depth.
 * Directories that individually contain many files stay as-is,
 * but many sibling directories each holding 1–2 files get merged
 * under their shared parent (up to depth 3).
 */
function formatNonCodeSummaries(nonCodeCounts: Map<string, Map<string, number>>): string[] {
  // First: aggregate all leaf counts up to depth-3 prefixes
  const SUMMARY_DEPTH = 3;
  const aggregated = new Map<string, Map<string, number>>();

  for (const [dir, extCounts] of nonCodeCounts) {
    const parts = dir.split('/');
    const prefix = parts.length > SUMMARY_DEPTH
      ? parts.slice(0, SUMMARY_DEPTH).join('/')
      : dir;
    let agg = aggregated.get(prefix);
    if (!agg) {
      agg = new Map<string, number>();
      aggregated.set(prefix, agg);
    }
    for (const [ext, count] of extCounts) {
      agg.set(ext, (agg.get(ext) ?? 0) + count);
    }
  }

  const lines: string[] = [];
  const sortedDirs = [...aggregated.keys()].sort();
  for (const dir of sortedDirs) {
    const extCounts = aggregated.get(dir)!;
    const parts: string[] = [];
    const sortedExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ext, count] of sortedExts) {
      parts.push(`${count} ${ext}`);
    }
    lines.push(`${dir}/ [${parts.join(', ')}]`);
  }
  return lines;
}

const REPEATED_NAME_THRESHOLD = 25;

/**
 * Detect filenames repeated 25+ times across different directories.
 * Replace them with a single example path + count, keeping unique files as-is.
 */
function collapseRepeatedNames(files: string[]): string[] {
  // Count occurrences of each basename
  const nameEntries = new Map<string, string[]>();
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    let entries = nameEntries.get(name);
    if (!entries) {
      entries = [];
      nameEntries.set(name, entries);
    }
    entries.push(file);
  }

  // Identify names that exceed the threshold
  const collapsedNames = new Map<string, string[]>();
  for (const [name, entries] of nameEntries) {
    if (entries.length >= REPEATED_NAME_THRESHOLD) {
      collapsedNames.set(name, entries);
    }
  }

  if (collapsedNames.size === 0) return files;

  // Build result: keep non-collapsed files, add summary lines at the end
  const collapsedSet = new Set<string>();
  for (const entries of collapsedNames.values()) {
    for (const entry of entries) {
      collapsedSet.add(entry);
    }
  }

  const kept = files.filter((f) => !collapsedSet.has(f));
  const summaries: string[] = [];
  for (const [name, entries] of [...collapsedNames.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // Find the common prefix path among all entries
    const dirs = entries.map((e) => e.slice(0, e.lastIndexOf('/')));
    let common = dirs[0] ?? '';
    for (let i = 1; i < dirs.length; i += 1) {
      while (common && !dirs[i].startsWith(common)) {
        common = common.slice(0, common.lastIndexOf('/'));
      }
    }
    const example = entries[0];
    summaries.push(`${common ? common + '/' : ''}.../${name} (e.g. ${example}) [repeated ${entries.length} times]`);
  }

  return [...kept, ...summaries];
}

export function scanRepoFiles(repoRoot: string, ignorePolicy: IgnorePolicy): string {
  const { codeFiles, nonCodeCounts } = scanRepoFilesRaw(repoRoot, ignorePolicy);
  const collapsed = collapseRepeatedNames(codeFiles.sort());
  const summaryLines = formatNonCodeSummaries(nonCodeCounts);
  return [...collapsed, ...summaryLines.length > 0 ? ['', '--- Non-code file summary ---', ...summaryLines] : []].join('\n');
}

// ---------------------------------------------------------------------------
// agents.md reader
// ---------------------------------------------------------------------------

export function readAgentsMd(repoRoot: string): string {
  if (!repoRoot) return '';
  const agentsPath = join(repoRoot, 'AGENTS.md');
  try {
    if (existsSync(agentsPath)) {
      const content = readFileSync(agentsPath, 'utf8').trim();
      if (content) return content;
    }
  } catch { /* ignore read errors */ }
  return '';
}

// Shared trailing agents.md block for every system prompt: empty when disabled or absent,
// otherwise the labelled project-instructions section.
// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function hasExactToolSurface(toolNames: readonly string[], expectedToolNames: readonly string[]): boolean {
  const actual = new Set(toolNames);
  return actual.size === expectedToolNames.length
    && expectedToolNames.every((toolName) => actual.has(toolName));
}

const COMPLETION_REVIEW_INSTRUCTION =
  'Before finishing, re-read the original task and any referenced spec or plan, compare the completed work against every requirement, and verify nothing was missed.';

function buildNativePlannerInstructions(toolNames: readonly string[]): string {
  if (toolNames.length === 0) {
    return 'No repository tools are available for this request; answer only from the supplied context.';
  }
  return [
    `Use only the request tools listed above: ${toolNames.join(', ')}.`,
    'You may call multiple independent tools in one response.',
    'You may include concise progress narration alongside tool calls.',
    'When the work is complete, return the final answer as content without tool calls.',
  ].join('\n');
}

function buildRestrictedToolSystemPrompt(options: {
  role: 'repo-search planner' | 'repository coding agent';
  context: PresetSystemContext;
  toolNames: readonly string[];
}): string {
  return [
    `You are a ${options.role}.`,
    buildNativePlannerInstructions(options.toolNames),
    options.context.hasRepoFileListing
      ? 'A repository file listing is provided in the system context.'
      : 'No startup repository file listing is available.',
    'Finish only when the requested work is complete, with a concise final output.',
    ...(options.role === 'repository coding agent' ? [COMPLETION_REVIEW_INSTRUCTION] : []),
  ].join('\n');
}

export function buildTaskSystemPrompt(
  context: PresetSystemContext,
  toolDefinitions: readonly PlannerToolDefinition[],
): string {
  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
  if (!hasExactToolSurface(toolNames, EXPOSED_REPO_TOOL_NAMES)) {
    return buildRestrictedToolSystemPrompt({ role: 'repo-search planner', context, toolNames });
  }
  const startupScanLine = !context.hasRepoFileListing
    ? '- No startup file listing provided — derive targeted grep searches from the task wording.'
    : '- A repository file listing is provided in this system message; use it to decide where to look.';
  return [
    'You are a repo-search planner.',
    buildNativePlannerInstructions(toolNames),
    '',
    'Role: repository search agent. Answer the task using concrete repo evidence from tool calls.',
    '',
    'Evidence:',
    '- Every claim needs tool evidence. No fabricated paths, lines, commands, or findings.',
    '- Prefer production source over tests/coverage/docs unless asked.',
    '- Flag weak/partial evidence explicitly. "No evidence of X" is a valid outcome.',
    '- Counts (tests, functions, matches, lines, etc.) only when a tool returned the number — cite the command. Otherwise describe without a number.',
    '',
    'Search discipline:',
    startupScanLine,
    '- No speculative reads. Open a file only when a grep match points there.',
    '- Iterative, targeted searches. If noisy, narrow `path`/`glob`/`pattern`.',
    '- Duplicate calls are auto-rejected. Vary keywords, path, or strategy.',
    '',
    'Anchor-before-read:',
    '- ≥3 of your first 5 calls MUST be grep keyword searches; no file reads or list calls until you have anchors.',
    '- Turn 1: pick 5 keywords from the task and grep `"k1|k2|k3|k4|k5"` with no path (searches from the repo root; the ignore policy filters noise). If empty, reformulate before drilling.',
    '- Files >500 lines: run a file-scoped grep anchor first.',
    '',
    'Output style + finish gate:',
    '- Concise, structured, tied to the question. Distinguish confirmed / inferred / unknown.',
    '- Anchors are single lines or <=20-line windows (e.g. `dir/foo.ts:45-60`). No whole-file or chapter ranges. Wider spans → cite multiple anchors.',
    '- `output` is anchor-bullets, not prose. If you would paraphrase, summarize, or state an uncited number, search more instead of finishing.',
    '- Minimum 5 tool-call turns before finish. Early finish is rejected with: "that was a shallow search, there might be more hidden references/usages. Dive deeper".',
    '',
    'Tool selection:',
    '- `grep` for code/keywords. `find` for filenames by glob. `ls` for directory structure.',
    '- `read` with one large window per anchor (never tiny consecutive slices). Lines you already read are skipped automatically, so re-reading with the same offset advances.',
    '- `git` for typed, read-only repo inspection. Choose operation `status`, `log`, `show`, `diff`, `blame`, `grep`, or `ls_files`; shell commands and Git options cannot be supplied.',
    '- Use multiple calls in one response only for genuinely independent searches.',
    '- Token-budget error on a read → strengthen the anchor (grep for a symbol), don\'t shrink the window.',
    '',
    'Tool behaviour (do not fight it):',
    '- Ignored paths (node_modules, dist, .git, …) are excluded from grep/find/ls automatically.',
    '- grep is case-insensitive unless you pass `ignoreCase:false`, and regex unless you pass `literal:true`.',
    '- grep caps at `limit` matches (default 100); find at 1000; ls at 500. Narrow rather than raising the cap.',
    '',
    'Forbidden:',
    '- Shell syntax in tool args. `grep`/`find`/`ls`/`read` take structured fields, not command lines — there is no `command` key on them.',
    '- Coverage-first noise; tiny-slice progression on one file; claims of mutation from read-only ops; answers without `file:line` evidence; paths outside the repo root.',
    '- Wrong arg shape — only documented keys (e.g. `startLine`/`endLine` instead of `offset`/`limit`, or empty `{}`, are rejected).',
  ].join('\n');
}

export function buildAgentSystemPrompt(
  context: PresetSystemContext,
  toolDefinitions: readonly PlannerToolDefinition[],
): string {
  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
  if (!hasExactToolSurface(toolNames, INTERACTIVE_REPO_TOOL_NAMES)) {
    return buildRestrictedToolSystemPrompt({ role: 'repository coding agent', context, toolNames });
  }
  const startupScanLine = !context.hasRepoFileListing
    ? '- No startup file listing provided — use grep/find/ls to discover where to work.'
    : '- A repository file listing is provided in this system message; use it to locate files.';
  return [
    'You are an expert coding assistant operating inside SiftKit, a repository coding agent.',
    'You help by reading files, searching the repository, editing code, writing new files, and running commands.',
    '',
    buildNativePlannerInstructions(toolNames),
    '',
    'Available tools:',
    '- read: read a file (line-numbered; use offset/limit for large files).',
    '- grep: search file contents by pattern.',
    '- find: locate files by glob.',
    '- ls: list a directory one level deep.',
    '- git: run ONE typed read-only operation (status/log/show/diff/blame/grep/ls_files).',
    '- web_search / web_fetch: consult the public web only when external/current info is needed.',
    '- write: create a file or fully overwrite one (creates parent dirs).',
    '- edit: exact-text replacement in an existing file; each oldText must match a unique, non-overlapping region.',
    `- run: execute a ${RUN_SHELL_LABEL} command in the repository root; returns stdout and stderr.`,
    '',
    'Guidelines:',
    '- Be concise. Show file paths clearly when working with files.',
    `- \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-Object -Last N, Select-String, Get-Content -Tail N). Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available.`,
    '- Prefer forward slashes for paths (`dashboard/node_modules`, `src/lib/foo.ts`), including inside `run` commands. If a native executable requires backslashes, JSON-escape each one as `\\\\`; an unescaped backslash in JSON can silently corrupt the argument.',
    '- Long `run` output is truncated to its tail, so final summaries and errors survive.',
    `- Commands for test, build, lint, and typecheck retain a curated final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines (summary and failure lines survive) under \`outputMode: "auto"\`; always use "auto" for these. Do not add tail pipelines or temporary redirection.`,
    '- Reserve `outputMode: "full"` for raw log streams where the untrimmed text itself is required. On a test/build/lint/typecheck command the first "full" request is served as "auto" with a notice; if the raw output is still required, repeat the identical run with "full" immediately.',
    '- Prefer `edit` (exact replacement) over `write` for existing files; use `write` only for new files or full rewrites.',
    '- Read a file before editing it; re-read after large edits to confirm the result.',
    '- Use `run` to verify changes (build, tests, lint) whenever a relevant check exists.',
    '- `git` is read-only here; staging and committing are not your job unless the task explicitly asks.',
    COMPLETION_REVIEW_INSTRUCTION,
    '- Finish with a short summary of what changed and any follow-ups — plain prose, not file:line anchor bullets.',
    startupScanLine,
  ].join('\n');
}

// Stable content (file listing) leads and the volatile task trails so consecutive
// runs share a server-side KV prefix (system prompt + listing) instead of
// diverging a few tokens into the first user message.
export function buildTaskInitialUserPrompt(question: string): string {
  return `Task: ${question}`;
}

// ---------------------------------------------------------------------------
// Terminal synthesis prompt (for runs that exhaust turns)
// ---------------------------------------------------------------------------

export function buildTerminalSynthesisInstruction(reason: string): string {
  return [
    `The run stopped before producing a final answer (reason: ${reason}).`,
    'Using only the evidence already present in this conversation, write the best-effort final answer now.',
    'Be explicit about uncertainty, include concrete file:line evidence when present, and return only the answer.',
  ].join('\n');
}

/**
 * The context-compaction instruction. It is appended after the conversation it summarizes;
 * that history is about to be deleted and replaced by the model's answer, so the sections
 * demanded here are exactly what a resumed run cannot reconstruct on its own.
 */
export function buildCompactionSummaryInstruction(): string {
  return [
    'You are compacting a long working conversation so the same model can resume it from the summary alone.',
    'The system instructions above remain active after compaction and must not be repeated in the summary.',
    'Only the completed conversation history above will be replaced by what you write.',
    'Write the summary as plain prose under these headings, in this order:',
    '1. Task and goal — what was asked, in the requester\'s terms.',
    '2. Current state — what is done, what is not.',
    '3. Key findings — concrete evidence, each with a file:line anchor where one exists.',
    '4. Decisions made — choices already settled, and why, so they are not relitigated.',
    '5. Tool results that still matter — reproduce exact error text, command output and identifiers verbatim.',
    '6. In-flight work — pending edits, the current hypothesis, and the next intended command.',
    'Rules:',
    '- Write for the model that must continue the work, not for a reader looking back.',
    '- Never invent a path, line number, symbol or result that is not in the conversation.',
    '- Prefer dropping commentary over dropping a concrete anchor or an exact error string.',
    '- Output the summary only. No preamble, no meta-commentary about summarizing.',
  ].join('\n');
}

export const TaskCommandSchema = z.object({
  command: z.string(),
  activityKind: ToolActivityKindSchema,
  activitySubject: ToolActivitySubjectSchema,
  turn: z.number(),
  modelVisibleCommand: z.string().optional(),
  safe: z.boolean(),
  reason: z.string().nullable(),
  exitCode: z.number().nullable(),
  output: z.string(),
  promptOutput: z.string().optional(),
  imageDataUrls: z.array(ImageDataUrlSchema).optional(),
  imageMeta: z.array(ImageMetadataSchema).optional(),
  outputTokens: z.number().optional(),
  outputTokensEstimated: z.boolean().optional(),
  promptTokenCount: z.number().int().nonnegative().optional(),
});
export type TaskCommand = z.infer<typeof TaskCommandSchema>;
