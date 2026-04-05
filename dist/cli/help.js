"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showHelp = showHelp;
function showHelp(stdout) {
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
