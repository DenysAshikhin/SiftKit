import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IgnorePolicy } from './command-safety.js';

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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (codeFiles.length >= SCAN_MAX_FILES) return;
      if (ignorePolicy.namesLower.has(entry.name.toLowerCase())) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (ignoredPaths.some((p) => relPath === p || relPath.startsWith(`${p}/`))) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
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
  const agentsPath = path.join(repoRoot, 'agents.md');
  try {
    if (fs.existsSync(agentsPath)) {
      const content = fs.readFileSync(agentsPath, 'utf8').trim();
      if (content) return content;
    }
  } catch { /* ignore read errors */ }
  return '';
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildTaskSystemPrompt(repoRoot: string, options?: {
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
}): string {
  const agentsContent = options?.includeAgentsMd === false ? '' : readAgentsMd(repoRoot);
  const startupScanLine = options?.includeRepoFileListing === false
    ? '- No startup file listing provided — derive targeted rg searches from the task wording.'
    : '- A file listing is provided in the user message; use it to decide where to look.';
  return [
    'You are a repo-search planner. Return ONE valid JSON object — no markdown fences.',
    'Action shape: {"action":"repo_*", ...args}. For independent read-only searches, use one {"action":"tool_batch","calls":[...]}.',
    'Command-based actions: the action prefix must match the command (repo_rg→rg, repo_git→git).',
    'Finish: {"action":"finish","output":"<anchor-bullets>"}.',
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
    '- No speculative reads. Open a file only when an rg match points there.',
    '- Iterative, targeted searches. If noisy, narrow path/pattern — do NOT add broad `--glob` exclusions.',
    '- Duplicate commands are auto-rejected. Vary keywords, path, or strategy.',
    '',
    'Anchor-before-read:',
    '- ≥3 of your first 5 calls MUST be rg keyword searches; no file reads or list calls until you have anchors.',
    '- Turn 1: pick 5 keywords from the task and run `rg -n "k1|k2|k3|k4|k5" src`. If empty, reformulate before drilling.',
    '- Files >500 lines: run a file-specific `rg` anchor first.',
    '- Two reads of the same file must have an `rg` search between them.',
    '',
    'Output style + finish gate:',
    '- Concise, structured, tied to the question. Distinguish confirmed / inferred / unknown.',
    '- Anchors are single lines or <=20-line windows (e.g. `src/foo.ts:45-60`). No whole-file or chapter ranges. Wider spans → cite multiple anchors.',
    '- `output` is anchor-bullets, not prose. If you would paraphrase, summarize, or state an uncited number, search more instead of finishing.',
    '- Minimum 5 tool-call turns before finish. Early finish is rejected with: "that was a shallow search, there might be more hidden references/usages. Dive deeper".',
    '',
    'Commands:',
    '- Read-only PowerShell only (Windows). Ignored paths are auto-filtered by runtime policy.',
    '- One command per turn; use `tool_batch` only for genuinely independent searches.',
    '- Tool selection: `rg -n "<pat>" <path>` for code/keywords; `repo_list_files` for filenames/dirs; `repo_read_file` with one large window per anchor (never tiny consecutive slices).',
    '- Repo state: `git status --short`. History: `git log`, `git show`.',
    '- Token-budget error on a read → strengthen the anchor (symbol/regex), don\'t shrink the window.',
    '',
    'Auto-normalization (do not fight it):',
    '- rg gets `--no-ignore` and ignore-policy `--glob`s appended unless you already pass an ignore-disabling flag.',
    '- `--type tsx`/`jsx` → `--type ts`/`js`.',
    '- Duplicate commands (post-normalization) are rejected.',
    '',
    'JSON examples:',
    '{"action":"repo_rg","command":"rg -n \\"invokePlannerMode\\" src"}',
    '{"action":"repo_list_files","path":"src","glob":"*.ts","recurse":true}',
    '{"action":"repo_read_file","path":"src\\\\summary.ts","startLine":861,"endLine":1100}',
    '{"action":"repo_git","command":"git status --short"}',
    '{"action":"finish","output":"src/config.ts:42 — definition; src/summary.ts:120-135 — call site"}',
    '',
    'Forbidden:',
    '- Unix-only: `ls -la`, `head`, `find`, `xargs`, `grep`, `rg --type-all`.',
    '- Coverage-first noise; broad `--glob` exclusions; tiny-slice progression on one file; chained shell (`;`/`&&`); claims of mutation from read-only ops; answers without `file:line` evidence; searches outside the repo root.',
    '- Wrong arg shape — only documented keys, single `command` per call (e.g. `cmd` instead of `command`, or empty `{}`, are rejected).',
    ...(agentsContent ? ['', '--- agents.md (project-specific instructions) ---', '', agentsContent] : []),
  ].join('\n');
}

export function buildTaskInitialUserPrompt(question: string, fileList?: string, options?: {
  includeRepoFileListing?: boolean;
}): string {
  const parts = [`Task: ${question}`];
  if (fileList && options?.includeRepoFileListing !== false) {
    parts.push('', '--- Repository file listing (respects .gitignore) ---', '', fileList);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Finish-validation prompt
// ---------------------------------------------------------------------------

export function buildFinishValidationPrompt(options: {
  question: string;
  finalOutput: string;
  evidenceText: string;
}): string {
  return [
    'You are validating a repo-search answer against gathered evidence.',
    'Return exactly one JSON object: {"verdict":"pass"|"fail","reason":"<short reason>"}',
    'Question: is the answer valid? is the answer well supported/justified?',
    '',
    `Task: ${options.question}`,
    `Proposed answer: ${options.finalOutput}`,
    '',
    'Evidence from tool calls and inserted results:',
    options.evidenceText || '[none]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Terminal synthesis prompt (for runs that exhaust turns)
// ---------------------------------------------------------------------------

export function buildTerminalSynthesisPrompt(options: {
  question: string;
  reason: string;
  transcript: string;
}): string {
  const evidenceText = options.transcript.trim() || '[none]';
  return [
    'You are finalizing a repo-search run that terminated before finish validation passed.',
    'Write a best-effort final answer from available evidence.',
    'Rules:',
    '- Be explicit about uncertainty.',
    '- Include concrete file:line evidence when present.',
    '- Keep it concise and directly answer the task question.',
    '',
    `Task: ${options.question}`,
    `Termination reason: ${options.reason}`,
    '',
    'Evidence from tool calls and inserted results:',
    evidenceText,
  ].join('\n');
}

export type TaskCommand = {
  command: string;
  safe: boolean;
  reason: string | null;
  exitCode: number | null;
  output: string;
};

