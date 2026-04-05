export function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    '  siftkit repo-search --prompt "find x y z in this repo"',
    '  siftkit -prompt "find x y z in this repo"',
    '',
  ].join('\n'));
}
