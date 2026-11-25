import test from 'node:test';
import assert from 'node:assert/strict';

import { findStatusTextProblem } from '../src/repo-search/status-text.ts';

test('a status line is one paragraph with no code, path or tool name', () => {
  for (const [text, problem] of [
    ['First line.\nSecond line.', /one paragraph/u],
    ['Running `npm test` now.', /code or backticks/u],
    ['Reading src/cli/args.ts for the bug.', /path/u],
    ['Reading src/cli now/', null],
    ['Reading src/cli/input next.', /path/u],
    ['Looking at C:\\repo now.', /path/u],
    ['Looking at ..\\other now.', /path/u],
    ['Looking in ./scratch now.', /path/u],
    ['Checking with run_check again.', /run_check/u],
    ['Next is record_review for this.', /record_review/u],
  ] as const) {
    const found = findStatusTextProblem(text);
    if (problem === null) assert.equal(found, null, text);
    else assert.match(found ?? '', problem, text);
  }
});

test('ordinary prose passes, including words that are also tool names', () => {
  for (const text of [
    'Confirming a suspected problem with how bad input is handled, before calling it a real bug.',
    'Going to read and run the remaining checks, then edit what they find.',
    'Comparing the before/after numbers and/or asking for more.',
    'Node.js starts cleanly at 24/7 load; 5 of 13 areas are done.',
  ]) assert.equal(findStatusTextProblem(text), null, text);
});
