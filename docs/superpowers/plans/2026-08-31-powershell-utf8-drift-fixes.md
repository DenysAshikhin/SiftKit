# PowerShell UTF-8 Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct PowerShell source prefixing with a grammar-preserving command host, make `stdinData` a truthful UTF-8 `$input` contract, and close all seven review gaps with direct regression evidence.

**Architecture:** Both spawn helpers call one private builder that parses user source independently with `[ScriptBlock]::Create`. Async calls with `stdinData` decode the console stream after the UTF-8 assignments and pipe one string into the scriptblock; the sole direct-console caller migrates to `$input`. Prompt, recording, and exact-byte tests pin the public contract without exposing the host wrapper.

**Tech Stack:** TypeScript, Node `node:test`, Windows PowerShell 5.1, existing test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-powershell-utf8-command-host-design.md`

## Global Constraints

- Work in the current checkout; do not create a worktree.
- Do not commit.
- Do not create temporary files.
- Preserve unrelated changes and the approved spec/plan files.
- Use strict TDD: observe the named red failure before each production behavior change.
- Keep TypeScript inferred end-to-end. Do not add `any`, type assertions, non-null assertions, namespace imports, schema-duplicating types, or unvalidated IO.
- Do not add dependencies, fallbacks, compatibility branches, parallel stdin paths, or dynamically passed functions.
- `[Console]::InputEncoding` failures remain loud; never catch or suppress them.

---

### Task 1: Grammar-preserving command host and exact output coverage

**Files:**
- Modify: `src/lib/powershell.ts`
- Modify: `tests/powershell-async.test.ts`

**Interfaces:**
- Consumes: existing `spawnPowerShellSync(command, options)` and `spawnPowerShellAsync(command, options)` signatures.
- Produces: one private `buildPowerShellInvocation(command: string): string`; unchanged exported helper signatures; private `POWERSHELL_UTF8_PRELUDE`.

- [ ] **Step 1: Extend the existing imports and add failing grammar regressions**

Import `spawnPowerShellSync` beside `spawnPowerShellAsync`. Append these tests:

```ts
test('commands beginning with a param block execute through the async shim', async () => {
  const result = await spawnPowerShellAsync('param(); Write-Output 42', { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '42\r\n');
});

test('commands beginning with a using statement execute through the async shim', async () => {
  const result = await spawnPowerShellAsync(
    'using namespace System.Text; [Encoding]::UTF8.WebName',
    { timeoutMs: 30_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'utf-8\r\n');
});
```

- [ ] **Step 2: Build and verify the grammar tests fail for the current direct prefix**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
```

Expected: both new tests fail with PowerShell parser errors; the `param()` failure includes `ExpectedExpression`, and the `using` failure includes `UsingMustBeAtStartOfScript`.

- [ ] **Step 3: Replace direct prefixing with one private command builder**

Keep the current prelude value but remove `export`. Replace its comment with the concrete boundary contract. Add this private helper after it:

```ts
/**
 * Sets native stdout decoding, native stdin encoding, and shim stdin decoding to UTF-8.
 * User source is parsed separately so first-position grammar remains valid and host details
 * never enter requested commands, duplicate fingerprints, or transcripts.
 */
const POWERSHELL_UTF8_PRELUDE =
  '[Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ';

function buildPowerShellInvocation(command: string): string {
  const commandWithExitGuard = `${command}\nif (-not $?) { exit 1 }`;
  const escapedCommand = commandWithExitGuard.replaceAll("'", "''");
  return `${POWERSHELL_UTF8_PRELUDE}& ([ScriptBlock]::Create('${escapedCommand}'))`;
}
```

In both spawn helpers, replace `` `${POWERSHELL_UTF8_PRELUDE}${command}` `` with `buildPowerShellInvocation(command)`.

- [ ] **Step 4: Verify grammar regressions are green**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
```

Expected: both grammar tests pass; all existing timeout/output/encoding tests still pass.

- [ ] **Step 5: Add direct sync coverage and remove broad trimming from text assertions**

Add a small explicit test helper near `powerShellCommandFor`:

```ts
function nodeEvalCommand(source: string): string {
  return `& '${process.execPath}' -e "${source}"`;
}
```

Use it for the three new Node `-e` commands already in the file. Replace exact text assertions as follows:

```ts
assert.equal(result.stdout, 'ℹ tests 3413\r\n');
assert.equal(result.stdout, 'ℹ ✔ ✖ café\r\n');
```

Add direct sync coverage:

```ts
test('sync shim decodes native UTF-8 output correctly inside the PowerShell pipeline', () => {
  const emitSummary = nodeEvalCommand("console.log('\\u2139 tests 3413')");
  const result = spawnPowerShellSync(
    `${emitSummary} | Select-String -Pattern '^\\u2139' | ForEach-Object { $_.Line }`,
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ℹ tests 3413\r\n');
});
```

- [ ] **Step 6: Make the `$OutputEncoding` regression byte-exact and verify it fails on BOMs**

Replace the native stdin reader in that test with:

```ts
const readStdinBytes = nodeEvalCommand(
  "const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('hex')));",
);
const result = await spawnPowerShellAsync(`'café ℹ' | ${readStdinBytes}`, {
  timeoutMs: 30_000,
});
assert.equal(result.exitCode, 0);
assert.equal(result.stdout, '636166c3a920e284b90d0a\r\n');
```

The expected bytes are UTF-8 for `café ℹ\r\n`; absence of the `efbbbf` prefix proves no BOM was sent.

- [ ] **Step 7: Build and verify the byte regression fails before the BOM-less fix**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
```

Expected: the byte-exact test fails because `[Text.Encoding]::UTF8` emits `efbbbf` preambles before `636166c3a920e284b90d0a`. Grammar and sync tests remain green.

- [ ] **Step 8: Use one BOM-less UTF-8 encoding object for all three boundaries**

Replace the private prelude value with:

```ts
const POWERSHELL_UTF8_PRELUDE =
  '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false); ';
```

- [ ] **Step 9: Run the Task 1 target**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
```

Expected: every test passes, including both grammar tests, the sync path, and byte-exact output.

### Task 2: Canonical UTF-8 `$input` contract and DPAPI migration

**Files:**
- Modify: `src/lib/powershell.ts`
- Modify: `tests/powershell-async.test.ts`
- Modify: `src/assistant/crypto/dpapi.ts`

**Interfaces:**
- Consumes: Task 1 private `buildPowerShellInvocation(command)` and existing `PowerShellAsyncOptions.stdinData?: string`.
- Produces: `buildPowerShellInvocation(command: string, pipeStdin: boolean): string`; `stdinData` delivered as one UTF-8 `$input` object; DPAPI consumes only `$input`.

- [ ] **Step 1: Restore the failing `$input` regression with exact output**

Replace the current stdin regression with:

```ts
test('stdinData is decoded as UTF-8 and delivered through $input', async () => {
  const result = await spawnPowerShellAsync('$input | ForEach-Object { $_ }', {
    timeoutMs: 30_000,
    stdinData: 'café ℹ',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'café ℹ\r\n');
});
```

- [ ] **Step 2: Build and verify the `$input` regression fails**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
```

Expected: the new `$input` test fails with OEM-decoded mojibake instead of `café ℹ`; the Task 1 tests stay green.

- [ ] **Step 3: Make stdin delivery a first-class builder mode**

Replace the Task 1 builder with:

```ts
function buildPowerShellInvocation(command: string, pipeStdin: boolean): string {
  const commandWithExitGuard = `${command}\nif (-not $?) { exit 1 }`;
  const escapedCommand = commandWithExitGuard.replaceAll("'", "''");
  const invokeCommand = `& ([ScriptBlock]::Create('${escapedCommand}'))`;
  return pipeStdin
    ? `${POWERSHELL_UTF8_PRELUDE}[Console]::In.ReadToEnd() | ${invokeCommand}`
    : `${POWERSHELL_UTF8_PRELUDE}${invokeCommand}`;
}
```

Call it with `false` in `spawnPowerShellSync` and with `options.stdinData !== undefined` in `spawnPowerShellAsync`.

- [ ] **Step 4: Migrate DPAPI completely to `$input`**

In `src/assistant/crypto/dpapi.ts`, replace the direct console read with:

```ts
"$payload = [Convert]::FromBase64String(@($input) -join '');",
```

Do not retain `[Console]::In.ReadToEnd()` or add a conditional compatibility path.

- [ ] **Step 5: Verify the canonical stdin contract and DPAPI**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
node dist\test-runner\run-tests.js assistant-dpapi
```

Expected: both targets pass, including the 48,000-byte DPAPI payload and fail-closed cases.

- [ ] **Step 6: Mutation-check all three encoding assignments independently**

For each mutation below, edit only the private prelude, rebuild, run `powershell-async`, observe the named regression fail, then restore the full prelude before continuing:

1. Use `'[Console]::InputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false); '` (omit `Console.OutputEncoding`); expected failure: `native UTF-8 output is decoded correctly inside the PowerShell pipeline`.
2. Use `'[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); '` (omit `$OutputEncoding`); expected failure: `PowerShell pipes non-ASCII text into native commands as UTF-8`, with non-UTF-8 byte hex.
3. Use `'[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false); '` (omit `Console.InputEncoding`); expected failure: `stdinData is decoded as UTF-8 and delivered through $input`, with mojibake.

After restoring the full prelude, rebuild and rerun both targets. Expected: both targets pass. Leave no mutation in the tree.

### Task 3: Precise prompt contract and clean recording invariant

**Files:**
- Modify: `src/repo-search/prompts.ts`
- Modify: `tests/repo-search-prompts.test.ts`
- Modify: `tests/repo-tools.test.ts`

**Interfaces:**
- Consumes: canonical `$input` contract from Task 2; existing `executeRepoTool`, `buildRepoToolRequestedCommand`, `buildEffectiveTranscriptAction`, and `fingerprintToolCall`.
- Produces: precise model guidance; one real-run integration regression pinning requested/model-visible command, fingerprint input, and transcript action.

- [ ] **Step 1: Tighten the prompt regression before changing guidance**

Replace the existing UTF-8 prompt test with:

```ts
test('buildAgentSystemPrompt states the exact UTF-8 boundaries and newline split idiom', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
  assert.match(
    prompt,
    /native command output, text piped to native commands, and stdin delivered through `\$input` use UTF-8/u,
  );
  assert.ok(prompt.includes('-split "`r?`n"'), 'must show the CRLF/LF-safe split idiom');
  assert.match(prompt, /handle both CRLF and LF/u);
  assert.doesNotMatch(prompt, /UTF-8 end-to-end|Native command output uses CRLF/u);
});
```

- [ ] **Step 2: Build and verify the prompt test fails**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js repo-search-prompts
```

Expected: the revised test fails against the old `UTF-8 end-to-end` and universal-CRLF wording.

- [ ] **Step 3: Replace the guidance with the precise contract**

Use this single guidance string, preserving the existing PowerShell-shell and no-nesting instructions:

````ts
const RUN_SHELL_GUIDANCE =
  `- \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-Object -Last N, Select-String, Get-Content -Tail N). Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available. Commands already run inside PowerShell — never wrap them in \`powershell -Command\`. Native command output, text piped to native commands, and stdin delivered through \`$input\` use UTF-8. Split captured text with -split "\`r?\`n" to handle both CRLF and LF; splitting on \`n alone leaves a trailing \`r on CRLF text, which makes $-anchored regexes fail.`;
````

- [ ] **Step 4: Add the real-run recording invariant regression**

Import `fingerprintToolCall` from `../src/tool-loop-governor.js`. Add to `tests/repo-tools.test.ts` near the existing real-run test:

```ts
test('run keeps the PowerShell host wrapper out of visible commands, fingerprints, and transcripts', async () => {
  const root = makeRepo();
  const args = { command: 'Write-Output marker-clean' };
  const result = await executeRepoTool(nativeCall('run', args), makeContext(root));
  assert.ok(result.ok);

  const requestedCommand = buildRepoToolRequestedCommand('run', args);
  assert.equal(result.requestedCommand, requestedCommand);
  assert.equal(result.command, requestedCommand);
  assert.doesNotMatch(result.command, /InputEncoding|OutputEncoding|ScriptBlock/u);

  const fingerprint = fingerprintToolCall({
    toolName: 'run',
    command: result.command,
    args,
  });
  assert.doesNotMatch(fingerprint, /InputEncoding|OutputEncoding|ScriptBlock/u);

  const transcriptAction = buildEffectiveTranscriptAction({
    toolName: 'run',
    rawArgs: args,
    commandToRun: result.command,
  });
  assert.deepEqual(transcriptAction, { toolName: 'run', args });
});
```

- [ ] **Step 5: Run both Task 3 targets**

Before the final run, add three PowerShell boundary regressions: a final native exit 7 maps to PowerShell exit 1; a later successful statement resets that failure to exit 0; and a final `Write-Error` maps to exit 1. Verify the failure cases are red against the unguarded scriptblock wrapper, then append `if (-not $?) { exit 1 }` inside the separately parsed script source as shown in Tasks 1-2.

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js repo-search-prompts
node dist\test-runner\run-tests.js repo-tools
```

Expected: both targets pass; the real run outputs `marker-clean`; visible commands, fingerprint, and transcript contain only the original run request.

### Task 4: Full verification and hygiene

**Files:** none; verification only.

- [ ] **Step 1: Typecheck and standalone lint**

Run:

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, failing scripts, error counts, and actionable file:line diagnostics."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail, warning/error counts, and actionable file:line diagnostics."
```

Expected: both commands exit 0 with no errors or warnings.

- [ ] **Step 2: Build and run every affected target**

Run:

```powershell
npm run build:test
node dist\test-runner\run-tests.js powershell-async
node dist\test-runner\run-tests.js assistant-dpapi
node dist\test-runner\run-tests.js repo-search-prompts
node dist\test-runner\run-tests.js repo-tools
node dist\test-runner\run-tests.js runtime-planner-mode
```

Expected: every target exits 0; `runtime-planner-mode` remains 58/58.

- [ ] **Step 3: Run the broader suite**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Return overall pass/fail, total/pass/fail/skipped counts, failing tests grouped by root cause, and relevant file:line anchors."
```

Expected baseline from the pre-fix tree: 3,451 total, 3,448 passed, 0 failed, 3 intentional skips. New tests increase the total/pass counts; failures remain zero and intentional skips remain three.

- [ ] **Step 4: Confirm complete migration and tree hygiene**

Use `siftkit repo-search` to verify:

- no production caller reads `[Console]::In` directly while passing `stdinData`;
- `POWERSHELL_UTF8_PRELUDE` is not exported or imported;
- both spawn helpers use the private builder;
- no `.trim()` remains in the four PowerShell encoding assertions;
- prompt text contains the precise contract and no `UTF-8 end-to-end` claim;
- only the approved implementation, test, spec, and plan files changed.

Then run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits 0; no temporary or unrelated files exist; no commit was created.

## Self-Review

- All seven drift findings map to a permanent code/test change or explicit mutation evidence.
- The stdin migration is a complete replacement: the host owns `[Console]::In`; user scripts and DPAPI consume `$input`; no compatibility branch remains.
- The command builder adds one necessary private function and no public API.
- All code snippets are TypeScript or PowerShell embedded in TypeScript; no forbidden type constructs appear.
- Tasks 1–3 are independently reviewable and suitable for sequential SiftKit repo-agent dispatches; Task 4 remains primary-agent verification.
