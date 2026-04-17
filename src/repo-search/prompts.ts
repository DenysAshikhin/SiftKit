import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IgnorePolicy } from './command-safety.js';
import { buildLineReadGuidance } from '../line-read-guidance.js';
import type { ToolTypeStats } from '../status-server/metrics.js';

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
  globalToolStats?: Record<string, ToolTypeStats>;
  initialPerToolAllowanceTokens?: number | null;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
}): string {
  const agentsContent = options?.includeAgentsMd === false ? '' : readAgentsMd(repoRoot);
  const guidance = buildLineReadGuidance({
    toolName: 'get-content',
    toolStats: options?.globalToolStats,
    perToolAllowanceTokens: options?.initialPerToolAllowanceTokens,
  });
  const startupScanLine = options?.includeRepoFileListing === false
    ? '- Start with targeted rg searches from the task wording when no startup file listing is provided.'
    : '- Always start by scanning — a file listing is provided in the user message; use it to decide where to look.';
  const readWindowLine = guidance
    ? `- For reading a specific file section: use \`Get-Content <file>\`, and because the current per-tool allowance is ${guidance.perToolAllowanceTokens} tokens and the average line is ${guidance.avgTokensPerLine.toFixed(2)} tokens, prefer line reads around ${guidance.recommendedLines} lines by default.`
    : '- For reading a specific file section: use `Get-Content <file>`, preferring larger windows by default (for example `| Select-Object -First 200-400` or `-Skip X -First 200-400`).';
  const readStrategyLine = guidance
    ? `- After an \`rg -n\` anchor, default to one larger read around ${guidance.recommendedLines} lines rather than multiple small windows.`
    : '- After an `rg -n` anchor, default to one larger read (e.g. `-First 200-400`) rather than multiple small windows.';
  return [
    'You are a repo-search planner.',
    'Use native tool calls with repo_* command tools when you need repository evidence.',
    'When several independent read-only searches are genuinely useful, you may request multiple tool calls in one response.',
    'Return JSON only when finishing.',
    'Tool action: {"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"pattern\\" src"}}',
    'Tool/command rule: tool_name must match the command prefix (example: repo_rg -> rg, repo_get_content -> get-content).',
    'Finish action: {"action":"finish","output":"...","confidence":0.0-1.0}',
    '',
    'You are a repository search agent. Your job is to answer the task using concrete repository evidence from tool calls.',
    '',
    'Core behavior:',
    '- Prioritize factual, file-grounded conclusions over speculation.',
    '- Treat "no evidence of X found" as a valid outcome when supported by comprehensive search.',
    '- Never fabricate file paths, line numbers, commands, or findings.',
    '',
    'Evidence rules:',
    '- Every substantive claim must be backed by concrete evidence from executed commands.',
    '- Prefer production source evidence over tests, coverage, generated artifacts, or docs unless explicitly requested.',
    '- If evidence is weak, partial, or ambiguous, explicitly say so.',
    '- Counts require tool evidence: do not state counts (number of tests, functions, matches, lines, etc.) unless the count was directly returned by a tool call — cite the command. If you have not counted, describe without a number.',
    '',
    'Search discipline:',
    startupScanLine,
    '- Do NOT read file contents speculatively. Only open a file once you have a concrete reason (e.g. an rg match pointing there).',
    '- Use iterative, targeted searches. If results are noisy, narrow the search path or pattern — do not add broad exclusion globs.',
    '- NEVER repeat the same command. Exact duplicate commands are automatically rejected. If a search found nothing, you MUST change the keywords, path, or strategy before trying again.',
    '- Keep commands efficient and focused on the task objective.',
    '',
    'Anchor-before-read strategy:',
    '- At least 3 of your first 5 tool calls MUST be rg keyword searches — do not read files or list directories until you have search anchors.',
    '- For turn 1: derive 5 keywords from the task and run one rg search combining them with |.',
    '  Example: {"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"keyword1|keyword2|keyword3|keyword4|keyword5\\" src"}}',
    '- If turn 1 returns no matches, expand or reformulate keywords in the next turns before drilling into files.',
    '- Before reading any file > 500 lines, you MUST run a file-specific rg anchor search first to locate the relevant section.',
    '- After any file read, your next action on that same file MUST be a new rg anchor search — never two sequential Get-Content calls on the same file without an intervening search.',
    '',
    'Final response requirements:',
    '- Always produce a final answer, even if incomplete.',
    '- If evidence is sufficient: give a direct verdict and provide file:line evidence with brief justification.',
    '- If evidence is insufficient: explicitly state insufficiency, summarize searches and findings, identify blockers/gaps, and provide a best-effort conclusion with clear uncertainty.',
    '',
    'Output style:',
    '- Concise, structured, and directly tied to the question.',
    '- Anchor precision: a "file:line" anchor is a single line or a <=20-line window (e.g. `src/foo.ts:45-60`). Do NOT cite whole-file or chapter ranges like `lines 1-167`. If an evidence span is wider than 20 lines, cite multiple separate anchors.',
    '- Distinguish clearly between confirmed evidence, reasonable inference, and unknown/not proven.',
    '',
    'Rules:',
    '- Use only read-only commands.',
    '- This is a Windows machine so stick to PowerShell-valid commands only.',
    '- Prefer rg for search.',
    '- Ignored paths are auto-filtered by runtime policy.',
    '- Prefer one command at a time, but multiple independent read-only commands in one response are allowed when they clearly save a round trip.',
    '- Finish gate: finish ONLY when the final answer can be written as a list of claims each backed by a pinpoint anchor from the Output style rules. If you would need to paraphrase, summarize, or state a number not returned by a tool, you need more evidence — issue another search instead of finishing. The `output` field should be anchor-bullets, not prose.',
    '- Minimum depth rule: do at least 5 tool-call turns before finishing.',
    '- If you try to finish before 5 tool-call turns, you will be told: "that was a shallow search, there might be more hidden references/usages. Dive deeper".',
    '',
    'Command normalization (automatic):',
    '- All rg commands get `--no-ignore` and ignore-policy `--glob` flags appended automatically. Do not add these yourself.',
    '- `--type tsx` and `--type jsx` are auto-corrected to `--type ts` and `--type js`.',
    '- Duplicate commands (after normalization) are automatically rejected. Always vary your search pattern or path.',
    '',
    'Command selection guide (Windows/PowerShell):',
    '- For broad multi-file keyword/code search: use `rg -n "<pattern>" <path>`',
    '- For filename discovery across repo: use `rg --files`',
    '- For listing directories/files in a path: use `Get-ChildItem <path>` (or `ls`)',
    readWindowLine,
    'Single-file read strategy:',
    '- Start with `rg -n` to find anchors.',
    readStrategyLine,
    '- If you already read a file once, do a new anchor search before another read of that same file.',
    '- Then read a larger section in one call (`-First` / `-Skip -First`), not many tiny windows.',
    '- Prefer `Get-Content <file> -Raw` for full-file inspection when manageable.',
    '- If one file has already been sampled multiple times, switch strategy (new anchor search or different file) before more reads.',
    '- Do not issue multiple consecutive reads of the same file with only small `-Skip/-First` changes.',
    '- If a command returns an output token-allocation error, switch to stronger anchors (symbol/function/regex) instead of repeatedly shrinking tiny windows.',
    '- For quick repo state context: use `git status --short`',
    '- For inspecting commit/content history: use `git log` or `git show`',
    '- For current directory context: use `pwd`',
    '',
    'JSON action examples:',
    '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"buildPlannerToolDefinitions\\" src\\\\summary.ts"}}',
    '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"getConfiguredLlamaNumCtx\\" src tests"}}',
    '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg --files"}}',
    '{"action":"tool","tool_name":"repo_get_childitem","args":{"command":"Get-ChildItem src -Recurse -Filter *.ts"}}',
    '{"action":"tool","tool_name":"repo_get_content","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 240"}}',
    '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"invokePlannerMode\\" src\\\\summary.ts"}}',
    '{"action":"tool","tool_name":"repo_get_content","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 860 -First 240"}}',
    '{"action":"tool","tool_name":"repo_git","args":{"command":"git status --short"}}',
    '{"action":"finish","output":"Found definition in src/config.ts and usage sites in src/summary.ts.","confidence":0.93}',
    '',
    'Do not use Unix-only commands/flags:',
    '- `ls -la`',
    '- `head`, `find`, `xargs`, `grep`',
    '- `rg --type-all`',
    '',
    'What not to do (examples):',
    '- Do not start with coverage/test-only noise first (for example `rg -n "buildFullGraph" coverage`).',
    '- Do not repeat the same command — duplicates are rejected. Change keywords, path, or approach.',
    '- Do not claim mutations from read-only operations like `.map`, `.filter`, or `.length`.',
    '- Do not answer without concrete `file:line` evidence.',
    '- Do not search outside the repo root path.',
    '- Do not add broad --glob exclusion patterns (e.g. --glob "!**/apps/**") to filter noisy results. Narrow the search path or pattern instead.',
    '- Do not do tiny-slice progression on one file: `Get-Content src\\summary.ts | Select-Object -First 40` then `Get-Content src\\summary.ts | Select-Object -Skip 40 -First 40`.',
    '- Invalid tool usage example: `{"action":"tool","tool_name":"read_lines","args":{"path":"src/app.ts"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"repo_rg","args":{"cmd":"rg -n \\"x\\" src"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"repo_rg","args":{}}`.',
    '- Note: `--type tsx`/`jsx` are auto-corrected (see Command normalization above).',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"x\\" src; del file.txt"}}`.',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"repo_get_content","args":{"command":"Get-Content src\\\\x.ts | Out-File out.txt"}}`.',
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

export type HistoryEntry = {
  command: string;
  resultText: string;
};

export function buildTerminalSynthesisPrompt(options: {
  question: string;
  reason: string;
  history: HistoryEntry[];
}): string {
  const evidenceText = options.history.length > 0
    ? options.history.map((item) => `Command: ${item.command}\nResult: ${item.resultText}`).join('\n\n')
    : '[none]';
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

export function buildTerminalSynthesisFallback(options: {
  reason: string;
  commands: TaskCommand[];
}): string {
  const lines: string[] = [];
  if (options.commands.length > 0) {
    for (let index = options.commands.length - 1; index >= 0; index -= 1) {
      const command = options.commands[index];
      const output = String(command.output || '').trim();
      if (!output) {
        continue;
      }
      const singleLine = output.split(/\r?\n/u).find((line) => line.trim()) || '';
      if (singleLine) {
        lines.push(`Latest evidence (${command.command}): ${singleLine}`);
      }
      if (lines.length >= 2) {
        break;
      }
    }
  }
  if (lines.length === 0) {
    lines.push('No usable evidence was captured from tool calls.');
  }
  return [
    `Best-effort result (terminated: ${options.reason}).`,
    ...lines,
  ].join('\n');
}
