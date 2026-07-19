export function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    '  siftkit repo-search --prompt "find x y z in this repo"',
    '  siftkit -prompt "find x y z in this repo"',
    '  siftkit preset list',
    '  siftkit run --preset <id> ...',
    '  siftkit run --command <cmd> [--arg <a> ...] --question "..."',
    '  siftkit run --shell <auto|pwsh|powershell|bash|sh|cmd> --command "<script>" --question "..."',
    '',
    'Run `siftkit preset list` to read server-managed CLI presets.',
    '',
  ].join('\n'));
}
