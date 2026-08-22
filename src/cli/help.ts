import { REPO_SEARCH_SYNOPSIS } from './args.js';
import { REPO_AGENT_CANONICAL_INVOCATION } from './repo-agent-help.js';

export function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    `  ${REPO_SEARCH_SYNOPSIS}`,
    `  ${REPO_AGENT_CANONICAL_INVOCATION}`,
    '  siftkit preset list',
    '  siftkit assistant <status|pause|resume|memory|policy|projections|evidence> ...',
    '  siftkit assistant <factory-reset|export|backup|restore> ...',
    '  siftkit run --preset <id> ...',
    '  siftkit run --command <cmd> [--arg <a> ...] --question "..."',
    '  siftkit run --shell <auto|pwsh|powershell|bash|sh|cmd> --command "<script>" --question "..."',
    '',
    'Run `siftkit preset list` to read server-managed CLI presets.',
    '',
    'On Windows, siftkit works from PowerShell, cmd, and Git Bash. Embedded double quotes',
    'in prompts are preserved; quote them per your shell. Run `npm run refresh-global` to',
    'rebuild and refresh the global install.',
    '',
  ].join('\n'));
}
