# Safety-Gate Allowlist + Single Novelty Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three validated review findings: (1) script-block/subexpression bodies in the repo-search `git` gate are guarded only by a cmdlet denylist that misses `New-Item`/`Set-Item`/`Invoke-Expression`/`iex`; (2) no runtime gate rejects mutating git subcommands (`git commit`, `git clean -fd` pass `evaluateCommandSafety`), so the invariant comment on `TREE_MUTATING_TOOL_NAMES` is false; (3) two exported novelty-classification entry points exist and callers diverge.

**Architecture:** Invert `evaluateCommandSafety` to allowlist-only: a read-only git subcommand allowlist for the producer segment, and a statement-position token allowlist inside every `{...}` and `(...)` body (delete `WRITE_OR_NETWORK_COMMAND_PATTERN`). Additionally block the single `&` call/background operator (except `2>&1`) and `::` static member access. With enforcement real, correct the `TREE_MUTATING_TOOL_NAMES` comment. Collapse novelty classification to one exported function, `classifyToolOutputNovelty`, deleting `classifyToolResultNovelty`.

**Tech Stack:** TypeScript, node:test via tsx.

**Repo rules in force:** TDD first; no type-assertion casts, no `any`, no non-null `!`, no namespace imports; no back-compat shims — deleted functions are deleted, callers migrate; DRY; typed end-to-end.

---

### Task 1: Allowlist rewrite of `evaluateCommandSafety`

**Files:**
- Modify: `src/repo-search/command-safety.ts` (lines 83-85 denylist, 117-169 helpers, 262-307 evaluate)
- Test: `tests/command-safety.test.ts`

Threat cases this closes (all currently pass the gate):
- `git ls-files | ForEach-Object { New-Item pwned.txt }` — cmdlet not on denylist
- `git ls-files | ForEach-Object { $null; New-Item pwned.txt }` — `;` legal at brace depth ≥ 1
- `git ls-files | Select-Object (New-Item pwned.txt)` — parens never scanned
- `git ls-files | ForEach-Object { & notepad $_ }` — single `&` call operator never blocked
- `git log & whoami` — single `&` background operator at top level
- `git ls-files | ForEach-Object { [System.IO.File]::Delete($_) }` — .NET static invocation
- `git commit -m x`, `git checkout .`, `git clean -fd`, `git reset --hard` — no subcommand gate at all

- [ ] **Step 1: Rewrite the script-block test and add the new failing tests**

In `tests/command-safety.test.ts`, replace the whole test `evaluateCommandSafety rejects a script block that writes, whichever cmdlet takes it` (lines 49-59) with:

```typescript
test('evaluateCommandSafety rejects a script block that writes, whichever cmdlet takes it', () => {
  for (const command of [
    'git log --oneline | ForEach-Object { Rename-Item $_ }',
    'git ls-files | Where-Object { Remove-Item $_ }',
    'git ls-files | Select-Object -Property @{ n = "x"; e = { Out-File $_ } }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not in the allow-list/u);
  }
});

test('evaluateCommandSafety rejects non-allow-listed invocations inside blocks and subexpressions', () => {
  for (const command of [
    'git ls-files | ForEach-Object { New-Item pwned.txt }',
    'git ls-files | ForEach-Object { Set-Item x y }',
    'git ls-files | ForEach-Object { Invoke-Expression $_ }',
    'git ls-files | ForEach-Object { iex $_ }',
    'git ls-files | ForEach-Object { $null; New-Item pwned.txt }',
    'git ls-files | Select-Object (New-Item pwned.txt)',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not in the allow-list/u);
  }
});

test('evaluateCommandSafety rejects call operators, dot-sourcing, and static member access', () => {
  for (const command of [
    'git ls-files | ForEach-Object { & notepad $_ }',
    'git log & whoami',
    'git ls-files | ForEach-Object { . .\\payload.ps1 }',
    'git ls-files | ForEach-Object { [System.IO.File]::Delete($_) }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
  }
});

test('evaluateCommandSafety rejects mutating git subcommands', () => {
  for (const command of [
    'git commit -m "x"',
    'git checkout .',
    'git clean -fd',
    'git reset --hard HEAD~1',
    'git push origin main',
    'git add .',
    'git -c alias.st=status st',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not read-only/u);
  }
});

test('evaluateCommandSafety allows expression-only script blocks including multi-statement ones', () => {
  for (const command of [
    'git ls-files | Select-Object -Property @{ n = "x"; e = { $_ } }',
    'git log --oneline | ForEach-Object { $parts = $_ -split " "; $parts[0] }',
    'git ls-files | Where-Object { -not ($_ -match "test") }',
    'git log --oneline | Where-Object { ($_ -match "fix") -and ($_ -notmatch "wip") }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, true, `expected ${command} to be allowed, got ${result.reason}`);
  }
});
```

Keep every other existing test unchanged — they must all still pass (notably `allows write-command substrings in path operands and quoted arguments` at lines 61-74: quoted spans are blanked before any body scan, so `--grep="remove-item"` stays legal, and all its git subcommands — `log`, `grep`, `show` — are on the read-only allowlist).

- [ ] **Step 2: Run the test file to verify the new tests fail**

Run: `npx tsx --test tests/command-safety.test.ts`
Expected: the four new/rewritten tests FAIL (threat commands currently return `safe: true`, mutating git subcommands return `safe: true`, and the rewritten script-block test fails on the reason match); all other tests PASS.

- [ ] **Step 3: Rewrite the gate in `src/repo-search/command-safety.ts`**

Delete `WRITE_OR_NETWORK_COMMAND_PATTERN` (lines 83-85) and `extractScriptBlockBodies` (lines 152-169). Immediately after `READ_ONLY_PIPE_COMMANDS`, add:

```typescript
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree',
  'cat-file', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'reflog',
  'show-ref', 'for-each-ref', 'merge-base', 'name-rev', 'count-objects',
  'diff-tree', 'diff-index', 'check-ignore',
]);

/** Git global flags whose value arrives as the next token (`-C <path>`, `-c <key>=<value>`). */
const GIT_FLAGS_WITH_SEPARATE_VALUE = new Set(['-C', '-c']);

/** First non-flag token after `git` — flag values are skipped so an alias defined via `-c` cannot smuggle a subcommand. */
function findGitSubcommand(producerTokens: string[]): string | null {
  for (let index = 1; index < producerTokens.length; index += 1) {
    const token = producerTokens[index];
    if (GIT_FLAGS_WITH_SEPARATE_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.toLowerCase();
  }
  return null;
}
```

Replace `hasBlockedOperator` (lines 117-141) with:

```typescript
function hasBlockedOperator(operatorScan: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < operatorScan.length; index += 1) {
    const char = operatorScan[index];
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      // Clamp so an unmatched `}` cannot drive the depth negative and unlock the `;` check.
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ';' && braceDepth === 0) {
      return true;
    }
    // `&` is the call/background/chaining operator everywhere except a `>&` stream merge (2>&1).
    if (char === '&' && operatorScan[index - 1] !== '>') {
      return true;
    }
    if (char === '|' && operatorScan[index + 1] === '|') {
      return true;
    }
  }
  return false;
}
```

Where `extractScriptBlockBodies` used to be, add the body allowlist machinery:

```typescript
/**
 * Bodies of `{ ... }` and `( ... )` groups — the places a command invocation can hide behind an
 * allow-listed pipeline stage. Operates on the fully quote-blanked scan: quoted braces/parens are
 * literal text, and anything executable inside double quotes needs `$(`/backtick, blocked separately.
 */
function extractBracketBodies(operatorScan: string): string[] {
  const bodies: string[] = [];
  const stack: { open: string; start: number }[] = [];
  for (let index = 0; index < operatorScan.length; index += 1) {
    const char = operatorScan[index];
    if (char === '{' || char === '(') {
      stack.push({ open: char, start: index });
      continue;
    }
    if (char === '}' || char === ')') {
      const expectedOpen = char === '}' ? '{' : '(';
      const top = stack[stack.length - 1];
      if (top && top.open === expectedOpen) {
        stack.pop();
        bodies.push(operatorScan.slice(top.start + 1, index));
      }
    }
  }
  return bodies;
}

/** Splits a body at `;` and `|` outside nested groups; nested bodies are validated on their own. */
function splitBodyStatements(body: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{' || char === '(') depth += 1;
    if (char === '}' || char === ')') depth = Math.max(0, depth - 1);
    if ((char === ';' || char === '|') && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements;
}

/** Leading characters that open a PowerShell expression rather than a command invocation. */
const EXPRESSION_TOKEN_PATTERN = /^[$'"@({[\d,+!-]/u;

/**
 * First statement-position token in `body` that could invoke a command and is not allow-listed.
 * Expression starters pass (they cannot invoke without `$(`/`::`/`&`, all blocked elsewhere);
 * `name = value` hashtable entries and assignments pass; bare words must be read-only cmdlets.
 */
function findBlockedBodyToken(body: string): string | null {
  for (const statement of splitBodyStatements(body)) {
    const token = getFirstCommandToken(statement);
    if (!token) continue;
    if (EXPRESSION_TOKEN_PATTERN.test(token)) continue;
    const rest = statement.trimStart().slice(token.length).trimStart();
    if (rest.startsWith('=') && !rest.startsWith('==')) continue;
    if (READ_ONLY_PIPE_COMMANDS.has(token)) continue;
    return token;
  }
  return null;
}
```

In `evaluateCommandSafety`, after the `hasFileRedirection` check add:

```typescript
  if (operatorScan.includes('::')) {
    return { safe: false, reason: 'static member access is not allowed' };
  }
```

Replace the `extractScriptBlockBodies` loop (lines 287-291) with:

```typescript
  for (const body of extractBracketBodies(operatorScan)) {
    const blockedToken = findBlockedBodyToken(body);
    if (blockedToken !== null) {
      return { safe: false, reason: `command '${blockedToken}' inside a script block or subexpression is not in the allow-list` };
    }
  }
```

And after the existing producer-token check (lines 294-297) add:

```typescript
  const subcommand = findGitSubcommand(tokenizeSegment(segments[0] || ''));
  if (subcommand !== null && !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { safe: false, reason: `git subcommand '${subcommand}' is not read-only` };
  }
```

(`subcommand === null` — bare `git`, or `git --version` — prints help/version, read-only, allowed.)

Update the file-top comment block for the deleted denylist if it still references it (the comment above `READ_ONLY_PIPE_COMMANDS`/old pattern at lines 83-84 goes away with the pattern).

- [ ] **Step 4: Run the test file to verify everything passes**

Run: `npx tsx --test tests/command-safety.test.ts`
Expected: ALL PASS, including the untouched pre-existing tests.

- [ ] **Step 5: Typecheck and full test suite**

Run: `npm run typecheck:test` then `npm test`
Expected: clean typecheck; all tests pass. If a repo-search integration test used a git subcommand that is genuinely read-only but missing from `READ_ONLY_GIT_SUBCOMMANDS`, add that subcommand to the set — do not weaken the check.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/command-safety.ts tests/command-safety.test.ts
git commit -m "fix: allowlist git subcommands and script-block statements in the safety gate"
```

---

### Task 2: Correct the `TREE_MUTATING_TOOL_NAMES` invariant comment

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:277-284`

Depends on Task 1: the comment's claim ("evaluateCommandSafety rejects every mutating git command") only becomes true once the subcommand allowlist exists. Comment-only change — no test.

- [ ] **Step 1: Replace the comment**

Replace lines 277-283 (the doc comment above `TREE_MUTATING_TOOL_NAMES`) with:

```typescript
/**
 * Tools that can change the working tree, so an identical earlier query may now have a different
 * answer and must not be rejected as a repeat. `git` is deliberately absent: evaluateCommandSafety
 * only admits READ_ONLY_GIT_SUBCOMMANDS and allow-listed read-only pipeline stages/script-block
 * statements, so a git call cannot change the tree. That is narrower than
 * MUTATING_COMMAND_TOOL_NAMES above, which stays conservative because a stale read window is worse
 * than a redundant one.
 */
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck:test`
Expected: clean.

```bash
git add src/repo-search/planner-protocol.ts
git commit -m "docs: ground the TREE_MUTATING_TOOL_NAMES invariant in the subcommand allowlist"
```

---

### Task 3: Single novelty entry point

**Files:**
- Modify: `src/tool-loop-governor.ts:23-27,142-166`
- Modify: `src/summary/planner/mode.ts:70,1246-1249`
- Test: `tests/tool-loop-governor.test.ts:4-12,139-149`

Delete `classifyToolResultNovelty` outright (no back-compat); `classifyToolOutputNovelty` becomes the only exported classifier. The summary planner passes `formatted.result.text` — the raw pre-fit tool output (`PlannerToolResult.text`, `src/summary/planner/tools.ts:41-44`) — as `baseOutput`.

- [ ] **Step 1: Migrate the tests**

In `tests/tool-loop-governor.test.ts`: remove `classifyToolResultNovelty,` from the import block (line 9), and replace the test at lines 139-149 with:

```typescript
test('classifyToolOutputNovelty detects repeated evidence with no new anchors', () => {
  const novelty = classifyToolOutputNovelty({
    baseOutput: 'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    promptResultText: 'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    recentEvidenceKeys: new Set([
      'apps/runner/src/server.ts:203: const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    ]),
  });

  assert.equal(novelty.hasNewEvidence, false);
  assert.equal(novelty.evidenceKeys.length, 1);
});
```

- [ ] **Step 2: Run to verify green before the source change**

Run: `npx tsx --test tests/tool-loop-governor.test.ts`
Expected: ALL PASS (the wrapper already delegates; this proves the migrated test is behavior-identical).

- [ ] **Step 3: Collapse the source functions**

In `src/tool-loop-governor.ts`: delete the `ClassifyToolResultNoveltyOptions` type (line 23) and the `classifyToolResultNovelty` function (lines 142-148), and replace `classifyToolOutputNovelty` (lines 150-166) with the folded version:

```typescript
/**
 * The novelty of one executed tool call. An empty output carries no anchors and so cannot be
 * novel — reporting it as new evidence hides a stalling planner from the no-new-evidence counter.
 */
export function classifyToolOutputNovelty(options: {
  baseOutput: string;
  promptResultText: string;
  recentEvidenceKeys: Set<string>;
}): ToolResultNovelty {
  if (options.baseOutput.length === 0) {
    return { evidenceKeys: [], hasNewEvidence: false };
  }
  const evidenceKeys = extractEvidenceKeys(options.promptResultText);
  return {
    evidenceKeys,
    hasNewEvidence: evidenceKeys.some((key) => !options.recentEvidenceKeys.has(key)),
  };
}
```

In `src/summary/planner/mode.ts`: change `classifyToolResultNovelty,` to `classifyToolOutputNovelty,` in the import block (line 70), and replace the call at lines 1246-1249 with:

```typescript
    const novelty = classifyToolOutputNovelty({
      baseOutput: formatted.result.text,
      promptResultText: formatted.promptResultText,
      recentEvidenceKeys: this.recentEvidenceKeys,
    });
```

- [ ] **Step 4: Typecheck and full test suite**

Run: `npm run typecheck:test` then `npm test`
Expected: clean typecheck (any missed `classifyToolResultNovelty` importer fails loudly here — that is the point); all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tool-loop-governor.ts src/summary/planner/mode.ts tests/tool-loop-governor.test.ts
git commit -m "refactor: collapse novelty classification to one exported entry point"
```
