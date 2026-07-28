# Repo-Agent Auto Default and Positional CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `siftkit repo-agent "task"` the canonical interactive invocation, default it to automatic approval, and prove `repo-search` remains approval-free by default.

**Architecture:** Keep the existing command catalog and shared repo-task runner. Tighten the repo-agent-specific token validator around one positional prompt, separate TTY requirements from whether an approval prompter is constructed, and change the repo-agent default at both CLI and server boundaries. Preserve repo-search routing and lock its no-approval default with end-to-end tests.

**Tech Stack:** TypeScript, Node.js test runner, Zod-derived types, HTTP/SSE integration tests, SiftKit output summarization.

## Global Constraints

- `repo-agent` accepts exactly one positional prompt; `--prompt` and `-prompt` are removed from that command.
- `repo-agent` defaults to `auto` independently in the CLI and `/repo-agent` server endpoint.
- Explicit `--approval interactive|auto|off` remains supported.
- Every repo-agent CLI mode requires a TTY, including `off`.
- Default `repo-search` remains non-interactive, requires no TTY, and creates no approval gate or reviewer.
- `repo-search --interactive` remains the only repo-search approval opt-in.
- Preserve full edit/write approval payload safety behavior.
- Use strict TDD: observe the intended failure before each production change.
- Keep TypeScript fully inferred and typed; no `any`, `unknown` laundering, casts, non-null assertions, or namespace imports.
- Keep implementation direct and DRY; do not add aliases, wrappers, compatibility shims, or a machine-readable approval protocol.
- Do not use a worktree.
- Route test output and diff interpretation through SiftKit with a 15-minute timeout.

---

### Task 1: Positional Repo-Agent Syntax, Help, and Documentation

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `tests/cli-command-surface.test.ts`
- Modify: `tests/cli-help.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `validateRepoAgentTokens(tokens: string[]): void`
- Produces: canonical `REPO_AGENT_SYNOPSIS` and validation for exactly one positional prompt
- Preserves: `parseArguments()` support for `--prompt` because repo-search still consumes it

- [ ] **Step 1: Add failing parser tests**

Replace the repo-agent validation test in `tests/cli-command-surface.test.ts` with focused cases:

```ts
test('validateRepoAgentTokens accepts one positional prompt around supported options', () => {
  assert.doesNotThrow(() => validateRepoAgentTokens([
    'make x',
    '--model',
    'm',
    '--log-file',
    'l',
    '--progress',
    '--approval',
    'auto',
  ]));
  assert.doesNotThrow(() => validateRepoAgentTokens([
    '--approval',
    'interactive',
    'make x',
  ]));
});

test('validateRepoAgentTokens rejects missing, multiple, and legacy prompts', () => {
  assert.throws(
    () => validateRepoAgentTokens([]),
    /repo-agent requires exactly one positional prompt/u,
  );
  assert.throws(
    () => validateRepoAgentTokens(['one', 'two']),
    /repo-agent accepts exactly one positional prompt; got 2/u,
  );
  assert.throws(
    () => validateRepoAgentTokens(['--prompt', 'make x']),
    /repo-agent no longer accepts --prompt/u,
  );
  assert.throws(
    () => validateRepoAgentTokens(['-prompt', 'make x']),
    /repo-agent no longer accepts -prompt/u,
  );
  assert.throws(
    () => validateRepoAgentTokens(['make x', '--approval']),
    /Missing value for repo-agent option: --approval/u,
  );
  assert.throws(
    () => validateRepoAgentTokens(['make x', '--no-approval']),
    /Unknown option for repo-agent/u,
  );
});
```

Keep the approval parser assertions, but use positional fixtures:

```ts
assert.equal(parseArguments(['make x', '--approval', 'auto']).approvalMode, 'auto');
assert.equal(parseArguments(['make x', '--approval', 'off']).approvalMode, 'off');
assert.equal(parseArguments(['make x']).approvalMode, undefined);
```

- [ ] **Step 2: Add failing help tests**

Update `tests/cli-help.test.ts`:

```ts
test('CLI help shows positional repo-agent syntax without the legacy prompt flag', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const output = stdout.read();
  assert.equal(code, 0);
  assert.match(output, /siftkit repo-agent "make change x"/u);
  assert.doesNotMatch(output, /siftkit repo-agent --prompt/u);
});

test('repo-agent help documents automatic approval as the default', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Approval defaults to auto/u);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run with a 15-minute timeout:

```powershell
npx tsx --test .\tests\cli-command-surface.test.ts .\tests\cli-help.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and every failing test with exact assertion text and file:line."
```

Expected failures:

- the current validator accepts zero or multiple positionals;
- it accepts `--prompt`;
- help still displays `repo-agent --prompt`;
- help says interactive approval is the default.

- [ ] **Step 4: Implement positional validation and canonical help**

Change `REPO_AGENT_SYNOPSIS` in `src/cli/args.ts`:

```ts
export const REPO_AGENT_SYNOPSIS =
  'siftkit repo-agent "make change x" [--model <model>] [--log-file <path>] [--approval <interactive|auto|off>] [--progress]';
```

Replace `validateRepoAgentTokens()` with a single-pass validator that skips option values and counts only real positionals:

```ts
export function validateRepoAgentTokens(tokens: string[]): void {
  const flagsWithValues = new Set(['--model', '--log-file', '--approval']);
  const booleanFlags = new Set(['--progress']);
  const helpFlags = new Set(['-h', '--h', '--help', '-help']);
  const legacyPromptFlags = new Set(['--prompt', '-prompt']);
  let positionalCount = 0;
  let helpRequested = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (helpFlags.has(token)) {
      helpRequested = true;
      continue;
    }
    if (legacyPromptFlags.has(token)) {
      throw new Error(
        `repo-agent no longer accepts ${token}; use a positional argument: siftkit repo-agent "task"`,
      );
    }
    if (booleanFlags.has(token)) {
      continue;
    }
    if (flagsWithValues.has(token)) {
      if (tokens[index + 1] === undefined) {
        throw new Error(`Missing value for repo-agent option: ${token}`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option for repo-agent: ${token}`);
    }
    positionalCount += 1;
  }

  if (helpRequested) {
    return;
  }
  if (positionalCount === 0) {
    throw new Error(
      'repo-agent requires exactly one positional prompt. Usage: siftkit repo-agent "task"',
    );
  }
  if (positionalCount !== 1) {
    throw new Error(
      `repo-agent accepts exactly one positional prompt; got ${positionalCount}.`,
    );
  }
}
```

Do not remove the `--prompt` cases from `parseArguments()`: they remain the
repo-search parser contract.

Update the agent-specific help lines in `src/cli/run-repo-search.ts`:

```ts
? `Usage: ${REPO_AGENT_SYNOPSIS}\n`
  + 'Approval defaults to auto; the model reviews each write/edit/run and escalates unsure decisions to you.\n'
  + '--approval interactive sends every approval-required action to you; --approval off disables approval checks.\n'
  + '--progress streams per-turn telemetry to stderr.\n'
```

- [ ] **Step 5: Add the agent-facing README section**

Insert after the existing repo-search section in `README.md`:

```markdown
### `siftkit repo-agent "task"` — supervised repository changes

Repo-agent can inspect and modify the repository from an interactive terminal.
Automatic approval is the default: clear safe actions proceed, while uncertain
actions prompt you to approve, deny, or abort. Use `--approval interactive` to
review every approval-required action or `--approval off` to disable checks.

```powershell
siftkit repo-agent "update the parser and run its relevant tests"
siftkit repo-agent "apply the migration" --approval interactive
siftkit repo-agent "run the trusted maintenance task" --approval off
```
```

Add `siftkit repo-agent` to the README's client-owned command list.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
npx tsx --test .\tests\cli-command-surface.test.ts .\tests\cli-help.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures with file:line."
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```powershell
git add -- src/cli/args.ts src/cli/run-repo-search.ts tests/cli-command-surface.test.ts tests/cli-help.test.ts README.md
git commit -m "feat(cli): add positional repo-agent invocation"
```

---

### Task 2: CLI Auto Default and Universal TTY Gate

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `tests/repo-agent-cli.test.ts`

**Interfaces:**
- Consumes: `readRepoAgentApprovalMode(tokens: string[]): ApprovalMode`
- Produces: default `auto`, mode-specific prompt extraction, and unconditional repo-agent TTY enforcement
- Preserves: `--approval off` skips approval plumbing but no longer skips the TTY gate

- [ ] **Step 1: Add a TTY stream helper to the CLI integration test**

In `tests/repo-agent-cli.test.ts`:

```ts
function makeTtyInput(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true });
}
```

- [ ] **Step 2: Write the failing default-auto integration test**

Adapt the existing mock-server test so the canonical invocation omits
`--approval`:

```ts
test('repo-agent positional prompt defaults to auto', async () => {
  // Keep the existing local health + /repo-agent mock server and env isolation.
  const code = await runCli({
    argv: ['repo-agent', 'make x'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: makeTtyInput(),
  });

  assert.equal(code, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].prompt, 'make x');
  assert.equal(received[0].approval, 'auto');
});
```

The server response must remain result-only so this test checks the outgoing
CLI request, not approval behavior inside a fake server.

- [ ] **Step 3: Write failing preflight tests for every approval mode**

Replace the separate default/auto non-TTY cases with:

```ts
test('every repo-agent approval mode requires a TTY before server contact', async () => {
  const invocations = [
    ['repo-agent', 'make x'],
    ['repo-agent', 'make x', '--approval', 'auto'],
    ['repo-agent', 'make x', '--approval', 'interactive'],
    ['repo-agent', 'make x', '--approval', 'off'],
  ];

  for (const argv of invocations) {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv,
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: new PassThrough(),
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /repo-agent requires a TTY/u);
  }
});
```

Retain a local server hit counter, as in the existing tests, and assert it
remains empty to prove validation occurs before server preflight.

Add pre-server syntax coverage through `runCli()`:

```ts
test('repo-agent rejects invalid positional syntax before server contact', async () => {
  const cases = [
    { argv: ['repo-agent'], error: /requires exactly one positional prompt/u },
    { argv: ['repo-agent', 'one', 'two'], error: /got 2/u },
    { argv: ['repo-agent', '--prompt', 'one'], error: /no longer accepts --prompt/u },
  ];
  for (const testCase of cases) {
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: testCase.argv,
      stdout: makeCaptureStream().stream,
      stderr: stderr.stream,
      stdin: makeTtyInput(),
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), testCase.error);
  }
});
```

- [ ] **Step 4: Run the focused test and verify RED**

```powershell
npx tsx --test .\tests\repo-agent-cli.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and every failed test with exact assertion, actual value, and file:line."
```

Expected failures:

- omitted approval is sent as `interactive`;
- positional prompt extraction and missing-prompt messaging are not
  agent-specific;
- `--approval off` bypasses the current TTY gate.

- [ ] **Step 5: Implement default auto and the universal TTY requirement**

In `src/cli/args.ts`:

```ts
/** Pre-parse peek used by dispatch's fail-fast TTY gate. Defaults to auto. */
export function readRepoAgentApprovalMode(tokens: string[]): ApprovalMode {
  const index = tokens.indexOf('--approval');
  return index === -1 ? 'auto' : parseApprovalModeValue(tokens[index + 1]);
}
```

In `src/cli/dispatch.ts`, remove the unused
`readRepoAgentApprovalMode` import and replace the repo-agent gate with:

```ts
if (!commandHelpRequested) {
  assertStdinIsTty(true, options.stdin, 'repo-agent');
}
```

In `runRepoTaskCli()` separate prompt extraction, TTY requirements, and
approval-prompt construction:

```ts
const parsed = parseArguments(tokens);
const prompt = options.mode === 'agent'
  ? (parsed.positionals[0] ?? '').trim()
  : (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
if (!prompt) {
  throw new Error(
    options.mode === 'agent'
      ? 'repo-agent requires exactly one positional prompt. Usage: siftkit repo-agent "task"'
      : 'A --prompt is required for repo-search.',
  );
}

const approvalMode = options.mode === 'agent'
  ? parsed.approvalMode ?? 'auto'
  : 'off';
const approvalPrompting = options.mode === 'agent'
  ? approvalMode !== 'off'
  : parsed.interactive === true;
const ttyRequired = options.mode === 'agent' || parsed.interactive === true;
assertStdinIsTty(
  ttyRequired,
  options.stdin,
  options.mode === 'agent' ? 'repo-agent' : '--interactive',
);
const approvalPrompter = approvalPrompting && options.stdin
  ? new CliApprovalPrompter({ input: options.stdin, output: options.stderr })
  : undefined;
```

Keep the request bodies explicit:

```ts
approval: approvalMode
```

for agent mode, and:

```ts
interactive: parsed.interactive === true
```

for search mode.

- [ ] **Step 6: Preserve explicit overrides in tests**

Keep parser assertions for all three values and retain an interactive-TTY
integration call using:

```ts
argv: ['repo-agent', 'make x', '--approval', 'off']
```

Assert the captured request contains `approval: 'off'`. The non-TTY test from
Step 3 separately proves the override does not bypass supervision.

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
npx tsx --test .\tests\cli-command-surface.test.ts .\tests\cli-help.test.ts .\tests\repo-agent-cli.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures with file:line."
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit**

```powershell
git add -- src/cli/args.ts src/cli/dispatch.ts src/cli/run-repo-search.ts tests/repo-agent-cli.test.ts
git commit -m "feat(repo-agent): default interactive CLI to auto approval"
```

---

### Task 3: Server-Side Auto Default

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/streamed-repo-agent-endpoint.test.ts`

**Interfaces:**
- Consumes: `/repo-agent` body field `approval?: unknown`
- Produces: omitted approval resolves to `ApprovalMode` value `auto`
- Preserves: explicit `interactive`, `auto`, and `off` behavior

- [ ] **Step 1: Make the existing manual endpoint test explicit**

Add the explicit field to the first `/repo-agent` integration fixture:

```ts
approval: 'interactive',
```

Rename it to:

```ts
test('POST /repo-agent with approval:"interactive" approves a write through the shared endpoint', ...)
```

This keeps the manual-flow test independent from the changed default.

- [ ] **Step 2: Write the failing omitted-approval endpoint test**

Add after the explicit-auto endpoint test:

```ts
test('POST /repo-agent defaults omitted approval to auto', async () => {
  const harness = await startHarness('siftkit-repo-agent-default-auto-');
  try {
    const written = path.join(process.cwd(), 'agent-endpoint-default-auto.txt');
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 4,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-default-auto.txt","content":"auto"}',
          '{"verdict":"approve","reason":"task-scoped write"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
      onProgress: async (event) => {
        if (event.kind !== 'approval_request') {
          return;
        }
        await postJson(`${harness.baseUrl}/repo-search/approval`, {
          requestId: String(event.requestId),
          approvalId: String(event.approvalId),
          decision: 'abort',
        });
      },
    });

    assert.ok(response.result, response.rawBody);
    assert.equal(fs.readFileSync(written, 'utf8'), 'auto');
    fs.rmSync(written, { force: true });
    assert.equal(
      response.progress.filter((event) => event.kind === 'approval_request').length,
      0,
    );
    const autoFrames = response.progress.filter(
      (event) => event.kind === 'approval_auto',
    );
    assert.equal(autoFrames.length, 1);
    assert.equal(autoFrames[0].verdict, 'approve');
  } finally {
    await harness.close();
  }
});
```

The abort callback prevents the current interactive default from hanging, so
the RED failure is immediate and attributable to the wrong default.

- [ ] **Step 3: Run the endpoint test and verify RED**

```powershell
npx tsx --test .\tests\streamed-repo-agent-endpoint.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and the exact default-auto test failure with file:line."
```

Expected: the omitted-approval test receives `approval_request`, aborts, and
fails because no successful result or `approval_auto` event exists.

- [ ] **Step 4: Change only the agent server default**

In `src/status-server/routes/core.ts`:

```ts
// Agent always gets the full surface; approval mode is interactive|auto|off
// (default auto). Search keeps its existing interactive/sanitize logic.
```

and:

```ts
const parsed = ApprovalModeSchema.safeParse(parsedBody.approval ?? 'auto');
```

Do not change:

```ts
if (this.mode !== 'agent') {
  return interactive ? 'interactive' : 'off';
}
```

- [ ] **Step 5: Run endpoint and approval-loop tests and verify GREEN**

```powershell
npx tsx --test .\tests\streamed-repo-agent-endpoint.test.ts .\tests\llm-auto-approval.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures with file:line."
```

Expected: explicit interactive/off/auto and omitted-auto cases all pass;
approve/deny/unsure loop tests remain green.

- [ ] **Step 6: Commit**

```powershell
git add -- src/status-server/routes/core.ts tests/streamed-repo-agent-endpoint.test.ts
git commit -m "feat(repo-agent): default server approval to auto"
```

---

### Task 4: Lock Repo-Search Approval-Free Defaults

**Files:**
- Modify: `tests/repo-search-cli.test.ts`
- Modify: `tests/streamed-repo-search-interactive.test.ts`

**Interfaces:**
- Consumes: default `repo-search --prompt` and `POST /repo-search`
- Proves: `interactive: false`, no TTY requirement, no approval reviewer, and no approval events
- Preserves: explicit `repo-search --interactive` manual approval test

- [ ] **Step 1: Strengthen the default CLI characterization test**

In `tests/repo-search-cli.test.ts`, retain the current invocation without
stdin and add:

```ts
assert.equal(first.interactive, false);
```

This proves the default CLI succeeds without a TTY and explicitly sends the
server's approval-off input.

- [ ] **Step 2: Add an end-to-end default git-action isolation test**

Add to `tests/streamed-repo-search-interactive.test.ts`:

```ts
test('default repo-search executes permitted git without any approval flow', async () => {
  const harness = await startHarness('siftkit-repo-search-no-approval-');
  try {
    const command = 'git grep -n "name" package.json';
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'find the package name',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 4,
        availableModels: ['mock-model'],
        mockResponses: [
          JSON.stringify({ action: 'git', command }),
          '{"action":"finish","output":"found it"}',
        ],
        mockCommandResults: {
          [command]: {
            exitCode: 0,
            stdout: 'package.json:2:  "name": "siftkit"',
            stderr: '',
          },
        },
      },
      timeoutMs: 20_000,
    });

    assert.ok(response.result, response.rawBody);
    assert.equal(
      response.progress.filter((event) => event.kind === 'approval_request').length,
      0,
    );
    assert.equal(
      response.progress.filter((event) => event.kind === 'approval_auto').length,
      0,
    );
  } finally {
    await harness.close();
  }
});
```

`git` is intentionally used because it is allowed in default repo-search but
is not in the repo-agent read-only approval exemption. If any approval gate or
LLM reviewer leaks into this flow, the test emits an approval event, consumes
the mock responses incorrectly, or fails to finish.

- [ ] **Step 3: Run characterization tests**

```powershell
npx tsx --test .\tests\repo-search-cli.test.ts .\tests\repo-search-cli-interactive.test.ts .\tests\streamed-repo-search-interactive.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and any approval event or TTY-related failure with file:line."
```

Expected: the new assertions pass before further production changes because
they lock existing repo-search behavior.

- [ ] **Step 4: Verify production isolation remains explicit**

Inspect the exact known lines in `src/status-server/routes/core.ts` and
`src/cli/run-repo-search.ts`; confirm they still implement:

```ts
return interactive ? 'interactive' : 'off';
```

and:

```ts
interactive: parsed.interactive === true
```

No production edit is expected in this task.

- [ ] **Step 5: Commit**

```powershell
git add -- tests/repo-search-cli.test.ts tests/streamed-repo-search-interactive.test.ts
git commit -m "test(repo-search): lock approval-free defaults"
```

---

### Task 5: Full Verification and Installed-Surface Readiness

**Files:**
- Verify: all files changed in Tasks 1-4
- Temporary: `.tmp/repo-agent-auto-default-validation/npm-cache`

**Interfaces:**
- Proves: source, tests, help, docs, and built artifacts agree
- Produces: clean committed branch ready for refresh/install

- [ ] **Step 1: Run all focused feature tests**

```powershell
npx tsx --test `
  .\tests\cli-command-surface.test.ts `
  .\tests\cli-help.test.ts `
  .\tests\repo-agent-cli.test.ts `
  .\tests\streamed-repo-agent-endpoint.test.ts `
  .\tests\llm-auto-approval.test.ts `
  .\tests\repo-search-cli.test.ts `
  .\tests\repo-search-cli-interactive.test.ts `
  .\tests\streamed-repo-search-interactive.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, total tests, and every failure with exact error and file:line."
```

Expected: all focused tests pass.

- [ ] **Step 2: Run typecheck and lint**

```powershell
npm run typecheck 2>&1 |
  siftkit summary --question "Return pass/fail and every TypeScript or lint error with exact file:line and message."
```

Expected: pass.

- [ ] **Step 3: Run the complete test suite with a workspace-local npm cache**

Create only:

```text
.tmp/repo-agent-auto-default-validation/npm-cache
```

Then run:

```powershell
$env:npm_config_cache=(Resolve-Path .\.tmp\repo-agent-auto-default-validation\npm-cache).Path
npm test 2>&1 |
  siftkit summary --question "Return overall pass/fail, passed/failed/skipped counts, duration, and every failure with exact test name and file:line."
```

Expected: zero failures.

- [ ] **Step 4: Build all distributable surfaces**

```powershell
npm run build 2>&1 |
  siftkit summary --question "Return pass/fail and every build error with exact project and file:line."
```

Expected: pass.

- [ ] **Step 5: Verify built help without contacting the server**

Use the package's built CLI entrypoint identified by `package.json` and run:

```powershell
siftkit repo-agent --help
```

Exact expected help facts:

- contains `siftkit repo-agent "make change x"`;
- contains `Approval defaults to auto`;
- does not contain `siftkit repo-agent --prompt`.

This is an exact-output check, so do not summarize away the help text.

- [ ] **Step 6: Review the final diff against the spec**

```powershell
git diff main...HEAD 2>&1 |
  siftkit summary --question "Audit against docs/superpowers/specs/2026-07-28-repo-agent-auto-default-positional-cli-design.md. Report PASS/FAIL for every acceptance criterion, TS-policy violations, repo-search approval-flow regressions, and untested branches with file:line anchors."
```

Also run exact whitespace validation:

```powershell
git diff --check
```

- [ ] **Step 7: Clean the validation directory**

Resolve and verify the exact absolute path is:

```text
<repo-root>\.tmp\repo-agent-auto-default-validation
```

Delete only that directory recursively, then assert `Test-Path` returns
`False`.

- [ ] **Step 8: Confirm final repository state**

Use SiftKit to interpret `git status --short`; verify:

- all planned commits exist;
- no temporary validation files remain;
- unrelated user changes, including any pre-existing `package-lock.json`
  worktree state, remain untouched.
