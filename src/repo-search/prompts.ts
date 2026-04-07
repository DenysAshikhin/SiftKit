import * as fs from 'node:fs';
import * as path from 'node:path';

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

export function buildTaskSystemPrompt(repoRoot: string): string {
  const agentsContent = readAgentsMd(repoRoot);
  return [
    'You are running as a repo-search planner.',
    'Return exactly one JSON action per turn.',
    'Allowed tool: {"action":"tool","tool_name":"run_repo_cmd","args":{"command":"..."}}',
    'Finish format: {"action":"finish","output":"...","confidence":0.0-1.0}',
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
    '',
    'Search discipline:',
    '- Use iterative searches and targeted file inspection.',
    '- Avoid repeating failed commands.',
    '- Adjust strategy when searches are too broad, noisy, or low-signal.',
    '- Keep commands efficient and focused on the task objective.',
    '',
    'Final response requirements:',
    '- Always produce a final answer, even if incomplete.',
    '- If evidence is sufficient: give a direct verdict and provide file:line evidence with brief justification.',
    '- If evidence is insufficient: explicitly state insufficiency, summarize searches and findings, identify blockers/gaps, and provide a best-effort conclusion with clear uncertainty.',
    '',
    'Output style:',
    '- Concise, structured, and directly tied to the question.',
    '- Include concrete file:line references when available.',
    '- Distinguish clearly between confirmed evidence, reasonable inference, and unknown/not proven.',
    '',
    'Return exactly one JSON action per turn.',
    'Allowed tool action: {"action":"tool","tool_name":"run_repo_cmd","args":{"command":"..."}}',
    'Finish action format: {"action":"finish","output":"...","confidence":0.0-1.0}',
    '',
    'Rules:',
    '- Use only read-only commands.',
    '- This is a Windows machine so stick to PowerShell-valid commands only.',
    '- Prefer rg for search.',
    '- Ignored paths from `.gitignore` are auto-filtered by runtime policy.',
    '- One command per turn.',
    '- Finish when you have enough evidence.',
    '- Minimum depth rule: do at least 5 tool-call turns before finishing.',
    '- If you try to finish before 5 tool-call turns, you will be told: "that was a shallow search, there might be more hidden references/usages. Dive deeper".',
    '',
    'Command selection guide (Windows/PowerShell):',
    '- For broad multi-file keyword/code search: use `rg -n "<pattern>" <path>`',
    '- For filename discovery across repo: use `rg --files`',
    '- For listing directories/files in a path: use `Get-ChildItem <path>` (or `ls`)',
    '- For reading a specific file section: use `Get-Content <file>` (optionally with `| Select-Object -First N` or `-Skip N -First M`)',
    'Single-file read strategy:',
    '- Start with `rg -n` to find anchors.',
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
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"buildPlannerToolDefinitions\\" src\\\\summary.ts"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"getConfiguredLlamaNumCtx\\" src tests"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg --files"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-ChildItem src -Recurse -Filter *.ts"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 240"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"invokePlannerMode\\" src\\\\summary.ts"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 860 -First 240"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"git status --short"}}',
    '{"action":"finish","output":"Found definition in src/config.ts and usage sites in src/summary.ts.","confidence":0.93}',
    '',
    'Do not use Unix-only commands/flags:',
    '- `ls -la`',
    '- `head`, `find`, `xargs`, `grep`',
    '- `rg --type-all`',
    '',
    'What not to do (examples):',
    '- Do not start with coverage/test-only noise first (for example `rg -n "buildFullGraph" coverage`).',
    '- Do not run the same failed command again without changing it.',
    '- Do not claim mutations from read-only operations like `.map`, `.filter`, or `.length`.',
    '- Do not answer without concrete `file:line` evidence.',
    '- Do not search outside the repo root path.',
    '- Invalid tool usage example: `{"action":"tool","tool_name":"read_lines","args":{"path":"src/app.ts"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"cmd":"rg -n \\"x\\" src"}}`.',
    '- Invalid args example: `{"action":"tool","tool_name":"run_repo_cmd","args":{}}`.',
    '- Note: `--type tsx` and `--type jsx` are auto-corrected to `--type ts` and `--type js` respectively.',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" src; del file.txt"}}`.',
    '- Invalid command parameter example: `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\x.ts | Out-File out.txt"}}`.',
    ...(agentsContent ? ['', '--- agents.md (project-specific instructions) ---', '', agentsContent] : []),
  ].join('\n');
}

export function buildTaskInitialUserPrompt(question: string): string {
  return `Task: ${question}`;
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
