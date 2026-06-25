import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySearchExit,
  evaluateCommandSafety,
  normalizePlannerCommand,
  parseDirectRgCommand,
} from '../src/repo-search/command-safety.js';

test('evaluateCommandSafety allows allowlisted read-only commands', () => {
  assert.equal(evaluateCommandSafety('rg -n "planner" src').safe, true);
  assert.equal(evaluateCommandSafety('git status --short').safe, true);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts').safe, true);
  assert.equal(evaluateCommandSafety('Select-String -Path "src\\*.ts" -Pattern "planner"').safe, true);
  assert.equal(
    evaluateCommandSafety('Select-String -Path src\\summary.ts -Pattern "planner|debug" | Select-Object -Last 5').safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('Get-ChildItem -Recurse -Filter *.ts -Name | Where-Object { $_ -notmatch \'node_modules\' } | Select-Object -First 30').safe,
    true
  );
});

test('normalizePlannerCommand adds ignore-case to rg searches by default', () => {
  const normalized = normalizePlannerCommand('rg -n "SKILL" src', {
    ignorePolicy: { names: new Array<string>(), namesLower: new Set<string>(), paths: new Array<string>() },
  });

  assert.equal(normalized.command, 'rg -n "SKILL" src --no-ignore --ignore-case');
  assert.equal(normalized.rewritten, true);
});

test('normalizePlannerCommand does not add ignore-case when rg case behavior is explicit', () => {
  const ignorePolicy = { names: new Array<string>(), namesLower: new Set<string>(), paths: new Array<string>() };

  assert.equal(
    normalizePlannerCommand('rg -n --case-sensitive "SKILL" src', { ignorePolicy }).command,
    'rg -n --case-sensitive "SKILL" src --no-ignore',
  );
  assert.equal(
    normalizePlannerCommand('rg -n --smart-case "SKILL" src', { ignorePolicy }).command,
    'rg -n --smart-case "SKILL" src --no-ignore',
  );
});

test('normalizePlannerCommand does not add ignore-case to rg file listing', () => {
  const normalized = normalizePlannerCommand('rg --files src', {
    ignorePolicy: { names: new Array<string>(), namesLower: new Set<string>(), paths: new Array<string>() },
  });

  assert.equal(normalized.command, 'rg --files src --no-ignore');
});

test('normalizePlannerCommand rewrites rg --include to --glob', () => {
  const normalized = normalizePlannerCommand('rg -n "from " apps/runner/src --include "*.ts"', {
    ignorePolicy: { names: new Array<string>(), namesLower: new Set<string>(), paths: new Array<string>() },
  });

  assert.equal(normalized.command, 'rg -n "from " apps/runner/src --glob "*.ts" --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported rg --include to --glob/u);
});

test('classifySearchExit treats rg exit 1 with empty output as no match', () => {
  const classification = classifySearchExit('rg -n "missing" src', 1, '');

  assert.equal(classification.noMatch, true);
  assert.equal(classification.syntaxFailure, false);
});

test('classifySearchExit treats rg exit 1 with PowerShell ParserError as command failure', () => {
  const classification = classifySearchExit(
    'rg -n "from [\'\\"]\\.\\./" apps/runner/src',
    1,
    'The string is missing the terminator: ".\nParserError: TerminatorExpectedAtEndOfString',
  );

  assert.equal(classification.noMatch, false);
  assert.equal(classification.syntaxFailure, true);
  assert.match(classification.message || '', /Command syntax failure/u);
});

test('classifySearchExit treats rg exit 1 with unrecognized flag as command failure', () => {
  const classification = classifySearchExit(
    'rg -n "from " apps/runner/src --include "*.ts"',
    1,
    'rg: unrecognized flag --include',
  );

  assert.equal(classification.noMatch, false);
  assert.equal(classification.syntaxFailure, true);
  assert.match(classification.message || '', /Command syntax failure/u);
});

test('parseDirectRgCommand preserves mixed quote regex', () => {
  const parsed = parseDirectRgCommand('rg -n "from [\'\\"]\\.\\./" apps/runner/src');

  assert.deepEqual(parsed, {
    args: ['-n', 'from [\'"]\\.\\./', 'apps/runner/src'],
  });
});

test('parseDirectRgCommand rejects piped rg commands', () => {
  assert.equal(parseDirectRgCommand('rg -n "from " apps/runner/src | Select-Object -First 20'), null);
});

test('parseDirectRgCommand allows regex alternation after escaped quote in direct rg', () => {
  const command = 'rg -n "from [\'\\"].*\\.internal|import.*\\/internal\\/" --glob "*.test.ts" apps/runner/src/__tests__';
  const parsed = parseDirectRgCommand(command);
  assert.notEqual(parsed, null);
  assert.equal(evaluateCommandSafety(command, process.cwd()).safe, true);
});

test('evaluateCommandSafety allows quoted semicolon rg search patterns', () => {
  assert.equal(evaluateCommandSafety('rg -n ";;" apps/runner/src --glob "*.ts"').safe, true);
  assert.equal(evaluateCommandSafety("rg -n 'case;branch' src").safe, true);
});

test('evaluateCommandSafety treats drive-letter regex literals as patterns, not repo-escape paths', () => {
  const repoRoot = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit';
  assert.equal(
    evaluateCommandSafety('rg -n "D:\\\\|C:\\\\Users\\\\denys" . --type js --type ts --type ps1 --type json', repoRoot).safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('Select-String -Path "src\\*.ts" -Pattern "C:\\\\Users\\\\denys|D:\\\\personal"', repoRoot).safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('rg -n "planner" C:\\Windows\\System32 --type ts', repoRoot).safe,
    false
  );
  assert.equal(
    evaluateCommandSafety('Get-Content D:\\personal\\models\\config.json', repoRoot).safe,
    false
  );
});

test('evaluateCommandSafety rejects destructive, network, and chained commands', () => {
  assert.equal(evaluateCommandSafety('rm -rf .').safe, false);
  assert.equal(evaluateCommandSafety('curl http://127.0.0.1:8097/v1/models').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src; del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('rg -n ";;" src; del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src | findstr summary').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts > out.txt').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts | Select-Object -First 10 | Out-File out.txt').safe, false);
});

test('normalizePlannerCommand appends rg ignore flags after regex alternation inside quotes', () => {
  const normalized = normalizePlannerCommand(
    'rg -n "from [\'\\"].*\\.internal|import.*\\/internal\\/" --glob "*.test.ts" apps/runner/src/__tests__',
    { repoRoot: process.cwd() },
  );

  assert.equal(normalized.rejected, undefined);
  assert.match(normalized.command, /internal\|import/u);
  assert.doesNotMatch(normalized.command, /--no-ignore\s+\|\s+import/u);
  assert.match(normalized.command, /apps\/runner\/src\/__tests__ --no-ignore/u);
});

// F14 (A5): rg/PowerShell rewrite decisions extracted from runTaskLoop loop cases.
const EMPTY_IGNORE_POLICY = { names: new Array<string>(), namesLower: new Set<string>(), paths: new Array<string>() };

test('normalizePlannerCommand rewrites unsupported rg --type tsx to --type ts', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type tsx src', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.equal(normalized.command, 'rg -n "foo" src --type ts --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type tsx to valid types/u);
});

test('normalizePlannerCommand rewrites unsupported rg --type jsx to --type js', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type jsx src', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.equal(normalized.command, 'rg -n "foo" src --type js --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type jsx to valid types/u);
});

test('normalizePlannerCommand collapses mixed rg --type ts and --type tsx to --type ts', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type ts --type tsx src', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.equal(normalized.command, 'rg -n "foo" src --type ts --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type tsx to valid types/u);
});

test('normalizePlannerCommand rewrites mixed --type jsx and --type tsx to --type js and --type ts', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type jsx --type tsx src', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.equal(normalized.command, 'rg -n "foo" src --type js --type ts --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type jsx, tsx to valid types/u);
});

test('normalizePlannerCommand keeps --glob while rewriting unsupported --type tsx', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type tsx --glob "*.tsx" src', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.equal(normalized.command, 'rg -n "foo" --glob "*.tsx" src --type ts --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type tsx to valid types/u);
});

test('normalizePlannerCommand does not double-add --no-ignore when rg already passes it', () => {
  const normalized = normalizePlannerCommand('rg -n "planner" src --no-ignore', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.match(normalized.command, /rg -n "planner" src --no-ignore/u);
  assert.doesNotMatch(normalized.command, /--no-ignore --no-ignore/u);
});

test('normalizePlannerCommand does not add --no-ignore when rg already passes -u', () => {
  const normalized = normalizePlannerCommand('rg -n "planner" src -u', { ignorePolicy: EMPTY_IGNORE_POLICY });
  assert.match(normalized.command, /rg -n "planner" src -u/u);
  assert.doesNotMatch(normalized.command, /src -u --no-ignore/u);
});

test('normalizePlannerCommand adds -Exclude ignore names to Get-ChildItem recurse', () => {
  const normalized = normalizePlannerCommand('Get-ChildItem src -Recurse -Filter *.ts', {
    ignorePolicy: { names: ['node_modules'], namesLower: new Set(['node_modules']), paths: [] },
  });
  assert.ok(normalized.command.startsWith('Get-ChildItem src -Recurse -Filter *.ts -Exclude '));
  assert.match(normalized.command, /node_modules/u);
  assert.match(normalized.note, /added -Exclude from ignore policy/u);
});

test('normalizePlannerCommand adds -Exclude ignore names to Select-String path scan', () => {
  const normalized = normalizePlannerCommand('Select-String -Path "src\\*.ts" -Pattern "planner"', {
    ignorePolicy: { names: ['node_modules'], namesLower: new Set(['node_modules']), paths: [] },
  });
  assert.ok(normalized.command.startsWith('Select-String -Path "src\\*.ts" -Pattern "planner" -Exclude '));
  assert.match(normalized.command, /node_modules/u);
  assert.match(normalized.note, /added -Exclude from ignore policy/u);
});

test('normalizePlannerCommand rejects Get-Content reads under ignored directories', () => {
  const normalized = normalizePlannerCommand('Get-Content node_modules\\leftpad\\index.js', { repoRoot: process.cwd() });
  assert.equal(normalized.rejected, true);
  assert.equal(normalized.rejectedReason, 'command targets a path ignored by policy');
});
