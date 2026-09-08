# Repo-agent turn overrides implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan sequentially in the current workspace. The user explicitly prohibited SiftKit. Do not dispatch repo-agent or other agents, create worktrees, or commit. This document authorizes planning only; await implementation authorization.

**Goal:** Expose an optional repo-agent CLI turn limit and a Web UI turn-limit pill, accepting values such as 1,000 and 10,000 without changing context budgeting.

**Architecture:** Carry the CLI override through the existing `maxTurns` API field. Expose the Web UI's existing session-local `planMaxTurnsInput` state and request plumbing. Validate textual input with one shared runtime schema; preserve backend default and preset precedence.

**Tech stack:** TypeScript, Zod, React, node:test, the repository's compiled test runner, React Testing Library.

**Spec:** The user's discussion in this session: optional `-turns`, custom turns alongside access pills, followed by explicit removal of the proposed 3,000-token floor. The approved scope is CLI and Web UI only. This document contains the complete behavior specification.

## Global constraints

- No SiftKit commands, including discovery, implementation, or output summarization.
- No worktrees, commits, dependency additions, destructive Git commands, or unrelated refactors.
- Preserve unrelated changes. Execute tasks sequentially and review each task before continuing.
- TypeScript only for code/tests. Parse IO with runtime schemas and infer new data types with `z.infer`. No `any`, type assertions, non-null assertions, namespace imports, unknown laundering, or duplicate schema-derived types.
- Use existing React event/prop callbacks; introduce no dynamic function dispatch or unnecessary classes.
- TDD: add failing behavioral tests, verify the expected failures, implement, rerun, then refactor.
- Keep temporary execution artifacts in one dedicated scratch directory and remove them at completion. The plan is a permanent deliverable, not scratch.
- Context budgeting, compaction, failed-command output policy, default turn constants, and turn-count semantics remain unchanged.

## Existing behavior and exact integration points

- `packages/contracts/src/config.ts`: `REPO_AGENT_DEFAULT_MAX_TURNS = 100`. This module is already re-exported by `packages/contracts/src/index.ts`.
- `src/repo-search/engine/runtime-profile.ts`: `resolveMaxTurns` honors explicit overrides before falling back to the task-kind default.
- `src/cli/repo-agent-args.ts`: `RepoAgentStartInvocationSchema` and `parseStartInvocation` currently omit turn overrides. This is a separate parser from the generic CLI `--max-turns` parser.
- `src/cli/repo-agent-command.ts`: `runStart` builds the server request.
- `src/cli/repo-agent-request.ts`: `buildRepoAgentServerRequest` currently omits `maxTurns` from its input and output construction.
- `src/repo-agent/api-schemas.ts`: `RepoAgentStartRequestSchema` already accepts optional positive integer `maxTurns`.
- `src/status-server/routes/chat-repo-agent.ts`: Web UI request validation already accepts `maxTurns`.
- `src/status-server/chat-repo-operation-runner.ts`: request override takes precedence over preset `maxTurns`, then the engine resolves the task-kind default.
- `dashboard/src/lib/chat-session-runtime-store.ts`: `planMaxTurnsInput` is already session-local, starts as an empty string, and is updated by the `plan-inputs` transition.
- `dashboard/src/lib/chat-composer-inputs.ts`: `parsePlanMaxTurnsOverride` currently accepts fractional numbers and silently drops invalid values. It serves plan, repo-search, and repo-agent callers.
- `dashboard/src/hooks/useChatSessions.ts`: `sendRepoAgent` already forwards the parsed override, but parsing currently happens after `submitRuntimeInputs`.
- `dashboard/src/hooks/useChatController.ts`: `onChangePlanRepoRoot` already preserves the turns input when changing the root. Add the inverse callback for turns.
- `dashboard/src/tabs/ChatTab.tsx`: `composer-plan-row` renders `RepoAgentApprovalModeControl`; place the new pill immediately after it. All send paths use `dispatchSend` or the hook methods.
- `src/repo-search/engine/turn-budget.ts`: the existing floor is 7.5% of `maxPromptTokens` per turn, divided across the batch. It is not a per-tool guarantee. Leave this behavior untouched as requested.

## Behavior contract

### CLI

```text
siftkit repo-agent "fix the issue" -turns 1000
siftkit repo-agent -turns 10000 "fix the issue" --approval auto
```

- Support precisely `-turns <number>` on start invocations. Do not add unrequested aliases or alter the generic CLI parser.
- Accept trimmed decimal digits representing integers from 1 through `Number.MAX_SAFE_INTEGER`. Leading zeros are permitted. Values such as `1k`, `1e3`, `0x10`, `+1`, `1.5`, `NaN`, and `Infinity` are invalid.
- Reject zero, negative values, missing values, unsafe integers, and duplicate `-turns` options with a clear error before starting a server request.
- Preserve positional task text and all existing model, image, approval, progress, and log-file options in any supported order.
- Omission must omit `maxTurns` from the request; the backend retains its existing default resolution. Do not insert a client-side 100 default.
- `decide` and `status` do not accept `-turns`; an existing run's limit is not changed through this flag.
- Help must document the valid range, default 100 for direct repo-agent CLI runs, and a 10,000-turn example. Use the exported default constant in generated help.

### Web UI

- Show a `Turns: <effective number>` pill only in repo-agent mode, immediately beside the access controls.
- Effective number is a valid explicit override, otherwise `selectedChatPreset.maxTurns ?? REPO_AGENT_DEFAULT_MAX_TURNS`. A custom preset's default must be shown accurately.
- Clicking the pill reveals a labelled numeric-entry field and `Reset to default` button. Use `type="text"` with `inputMode="numeric"` so malformed text is retained and can be explained rather than browser-sanitized into an empty/default value.
- Empty or whitespace-only input means no override. Nonempty values follow the CLI's decimal positive-safe-integer rules.
- Invalid input stays visible, has `aria-invalid`, and displays `Enter a whole number from 1 to 9007199254740991.` The pill reads `Turns: Invalid` while invalid; do not present a misleading effective default.
- Invalid input disables Run Agent and Retry and is guarded in `dispatchSend`. The hook independently validates before consuming the draft/images or beginning an operation; direct hook calls must not bypass validation.
- Reset writes an empty input, clears the error, and restores the current preset/default label. It does not change the preset.
- Keep the raw value in existing session runtime state. It survives switching away and back within the mounted dashboard and is isolated between sessions. Persistence across browser reloads is not part of this change.
- Editing affects subsequent runs only. Disable the turns control while the selected session is busy, including parked/remote operations, using existing session-busy derivation. Do not alter approval controls or their ability to resolve a running operation.
- Close the editor when switching sessions; key the component by session ID so local open state cannot leak. Closing the editor does not discard its session input.
- Do not expose a new turns control in plan, repo-search, direct chat, or summary modes. Existing shared parsing callers must nevertheless migrate completely to the validated parser behavior.

## Task 1: Validate and forward CLI turn overrides

**Modify:**

- `packages/contracts/src/config.ts`
- `src/cli/repo-agent-args.ts`
- `src/cli/repo-agent-command.ts`
- `src/cli/repo-agent-request.ts`
- `src/cli/repo-agent-help.ts`
- `tests/repo-agent-args.test.ts`
- `tests/repo-agent-command.test.ts`
- `tests/repo-agent-cli.test.ts`
- `README.md` (repo-agent usage section)

**Produces:** exported `RepoAgentTurnsInputSchema`, converting a validated nonempty textual turn limit to a number; optional `maxTurns` on parsed start invocations and server request-builder input. The existing API remains unchanged.

- [ ] Add parser regression tests, including these core cases:

```ts
for (const value of ['1', '1000', '10000', '9007199254740991']) {
  test(`repo-agent accepts -turns ${value}`, () => {
    const invocation = parseRepoAgentInvocation(['task', '-turns', value]);
    assert.equal(invocation.kind, 'start');
    if (invocation.kind !== 'start') throw new Error('Expected start invocation');
    assert.equal(invocation.maxTurns, Number(value));
    assert.equal(invocation.task, 'task');
    assert.equal(invocation.taskTokenCount, 1);
  });
}

for (const value of ['0', '-1', '1.5', '1k', '1e3', '0x10', '+1', 'NaN', 'Infinity', '9007199254740992', '']) {
  test(`repo-agent rejects invalid -turns ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseRepoAgentInvocation(['task', '-turns', value]), /turns/i);
  });
}

test('repo-agent rejects duplicate turn overrides', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['task', '-turns', '1', '-turns', '1000']),
    /turns/i,
  );
});
```

- [ ] Also cover omission (no own `maxTurns` field), missing value, option before task, leading zeros/trimmed digits, and combination with every existing start option. Confirm decide/status reject this option using existing valid UUID fixtures.
- [ ] Extend the existing command/CLI server fixture tests to capture the HTTP start body: explicit `10000` arrives as numeric `maxTurns: 10000`; omission has no field; invalid input issues no start request. Reuse `RepoAgentTestServer.startRequests`; validate captured IO with `RepoAgentStartRequestSchema` where its fixture shape permits.
- [ ] Build and run the focused tests. The first expected failure is unsupported `-turns` or absent request forwarding, not a broken test environment. Type errors referencing the planned invocation field may precede behavioral failures; add only the schema declaration needed to compile, then verify parser/forwarding tests still fail.

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-args repo-agent-command repo-agent-cli
```

- [ ] Add the shared text schema beside the existing repo-agent default:

```ts
export const RepoAgentTurnsInputSchema = z.string().trim()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
```

- [ ] Add optional `maxTurns` to `RepoAgentStartInvocationSchema`, reusing `RepoAgentStartRequestSchema.shape.maxTurns` rather than defining another request-field contract. Track one `let maxTurns: number | undefined` in `parseStartInvocation`. For `-turns`, reject a second occurrence, read its value with `readOptionValue`, `safeParse` with the shared schema, and throw the stated clear range error when invalid.
- [ ] Include `maxTurns` in the common parsed invocation object only when supplied; it must survive all existing model/log-file branches. Pass it through `runStart` and `buildRepoAgentServerRequest` using conditional object spreads and the existing final request-schema parse.

```ts
...(maxTurns === undefined ? {} : { maxTurns })
```

- [ ] Extend help options and examples. Add a README example and explain that this is a maximum run turn budget, with default 100 and normal early completion still possible.
- [ ] Rerun focused tests after rebuilding. Review the diff for omitted-option behavior, accidental parser changes, and duplicate parsing logic. No commit.

**Acceptance:** Real CLI invocation reaches the existing HTTP boundary with the exact selected integer, invalid options fail before a start request, existing options keep working, and help exposes the new option.

## Task 2: Expose and validate the Web UI override

**Create:**

- `dashboard/src/components/RepoAgentTurnsControl.tsx`
- `dashboard/tests/repo-agent-turns-control.test.tsx`

**Modify:**

- `dashboard/src/lib/chat-composer-inputs.ts`
- `dashboard/src/hooks/useChatSessions.ts`
- `dashboard/src/hooks/useChatController.ts`
- `dashboard/src/tabs/ChatTab.tsx`
- `dashboard/src/styles/chat.css`
- `dashboard/tests/chat-composer-inputs.test.ts`
- `dashboard/tests/chat-tab.test.tsx`
- `dashboard/tests/hooks/useChatSessions.test.tsx`
- `dashboard/tests/chat-session-runtime-store.test.ts`
- `README.md` (describe the session-local control next to the CLI documentation)

**Consumes:** `RepoAgentTurnsInputSchema` from Task 1, existing runtime `planMaxTurnsInput`, existing `setSessionPlanInputs`, and backend `maxTurns` precedence.

**Produces:** `parsePlanMaxTurnsOverride(input: string)` retains its name and successful return shape, but derives its result from a runtime schema. Empty input returns `{}`; valid input returns `{ maxTurns }`; nonempty invalid input throws a clear validation error. The UI uses the same exported schema's `safeParse` for inline errors.

- [ ] Replace the parser's handwritten `ParsedMaxTurnsOverride` union with a schema-derived type. Define and export the following optional-input schema in `chat-composer-inputs.ts`; remove the old unvalidated number conversion completely:

```ts
export const PlanMaxTurnsOverrideSchema = z.string().trim().pipe(
  z.union([
    z.literal('').transform(() => ({})),
    RepoAgentTurnsInputSchema.transform((maxTurns) => ({ maxTurns })),
  ]),
);
export type ParsedMaxTurnsOverride = z.infer<typeof PlanMaxTurnsOverrideSchema>;
```

The actual implementation follows the failing tests below; this block specifies the interface, not permission to skip red tests. The parser uses `safeParse` and throws `Error('Enter a whole number from 1 to 9007199254740991.')` for unsuccessful parses so the hook and UI can display consistent text. Export that message once from this module for UI reuse.

- [ ] Write parser regression tests first. Keep the valid `45` case; change the old invalid-to-empty expectations because silent fallback is intentionally removed. Add the complete invalid matrix from Task 1 plus blank/whitespace, 1, 1000, 10000, and the safe-integer boundary:

```ts
assert.deepEqual(parsePlanMaxTurnsOverride(''), {});
assert.deepEqual(parsePlanMaxTurnsOverride('  '), {});
assert.deepEqual(parsePlanMaxTurnsOverride('10000'), { maxTurns: 10000 });
assert.throws(() => parsePlanMaxTurnsOverride('1.5'), /whole number/);
assert.throws(() => parsePlanMaxTurnsOverride('1k'), /whole number/);
```

- [ ] Add hook tests that set existing session plan inputs to `10000`, submit repo-agent, and inspect the POST body. Cover clearing/resetting (field absent), invalid input (no POST, no activity start, unchanged draft/images), and switching between two sessions with different inputs. Extend existing fetch fixtures; do not add a live model dependency.
- [ ] Implement parsing before `submitRuntimeInputs` in `sendPlan`, `sendRepoSearch`, and `sendRepoAgent`. Catch only validation at this point, report it through the existing session error mechanism, and return without consuming input. Store the parsed override once and spread it into the request. This is a complete migration of all callers of the stricter shared parser, with no legacy invalid-to-default path.
- [ ] Add the control with this React prop interface (callbacks are required by the UI API):

```ts
export function RepoAgentTurnsControl(props: {
  value: string;
  defaultMaxTurns: number;
  disabled: boolean;
  onChange(value: string): void;
})
```

Use local state only for whether the editor is open. Render an `hchip` button with `aria-expanded`, a labelled input with `inputMode="numeric"`, an associated validation message, and a reset button that calls `onChange('')`. Derive validation through `PlanMaxTurnsOverrideSchema.safeParse(props.value)`. Extract a present override with an explicit property guard (`'maxTurns' in parsed.data`), never a cast. Use a React-generated ID for label/error linkage. Add only the minimal layout styles needed to wrap alongside existing access pills.
- [ ] Before implementing the component, write interactive tests for opening, typing 1000/10000, callback values, invalid text retention/error semantics, reset, custom preset default 250, and disabled controls. For example, using a stateful test host with default 100:

```ts
fireEvent.click(screen.getByRole('button', { name: 'Turns: 100' }));
fireEvent.change(screen.getByLabelText('Maximum turns'), { target: { value: '10000' } });
assert.ok(screen.getByRole('button', { name: 'Turns: 10000' }));
fireEvent.change(screen.getByLabelText('Maximum turns'), { target: { value: '1k' } });
assert.equal(screen.getByLabelText('Maximum turns').getAttribute('aria-invalid'), 'true');
fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
assert.ok(screen.getByRole('button', { name: 'Turns: 100' }));
```

- [ ] Add `onChangePlanMaxTurns(value: string): void` to `ChatTabProps` and its controller wiring. The handler calls `setSessionPlanInputs(selectedSessionId, selectedRuntime.planRepoRootInput, value)` after explicitly handling missing session/runtime. Do not introduce another turns state field. Update every `ChatTabProps` test fixture; missing migrations must fail at typecheck.
- [ ] Render `RepoAgentTurnsControl` beside approval controls, keyed by `selectedSessionId`, reading `selectedRuntime.planMaxTurnsInput`, using `selectedChatPreset?.maxTurns ?? REPO_AGENT_DEFAULT_MAX_TURNS`, and disabling it with `selectedSessionBusy`.
- [ ] Derive invalid-input state for repo-agent mode in `ChatTab`, include it in Run Agent/Retry disable conditions, and guard `dispatchSend`. Preserve existing Stop behavior. Render error text accessibly even if the editor is closed so a disabled send button has an explanation.
- [ ] Add ChatTab integration tests: control visible only for repo-agent, default/preset label, new change callback, invalid input blocks both send and retry, busy session disables editing, Stop remains available, switching sessions closes the editor and displays the selected session's value. Add a runtime-store test proving turns changes preserve repo root and root changes preserve turns.
- [ ] Execute red/green cycles with the compiled runner. Rebuild after every source/test change before invoking it:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-composer-inputs repo-agent-turns-control chat-tab useChatSessions chat-session-runtime-store
```

- [ ] Review all call sites of `parsePlanMaxTurnsOverride`, `ChatTabProps`, and `setSessionPlanInputs` with direct `rg`; confirm no silent invalid fallback or duplicate override state remains. No commit.

**Acceptance:** A user can set/reset a session-local repo-agent limit in the access-control row, invalid text cannot launch a run or discard drafts, the request carries the selected value, and preset defaults are represented correctly.

## Task 3: Verify end-to-end behavior and close out

**Test files:**

- `tests/streamed-repo-agent-endpoint.test.ts`
- `tests/status-server-chat-repo-agent.test.ts`
- Existing CLI and dashboard tests from Tasks 1–2
- `tests/engine-turn-budget.test.ts` (run unchanged)

**No production behavior changes are planned in this task.** If a regression is discovered, reproduce it with a failing test and fix only the scoped CLI/UI plumbing.

- [ ] Extend existing mock-model endpoint tests to assert `maxTurns: 1000` and `10000` are reflected in emitted progress/result metadata without clamping to 100. Use a short read plus the existing `repoAgentFinishResponses` fixture so each test completes in a few turns. A large limit is a ceiling, not a requirement to execute thousands of calls.
- [ ] For the chat endpoint, assert explicit override wins over a preset default; omission uses a custom preset limit; omission with the built-in/default configuration uses 100. Use the existing dashboard server fixture and deterministic model responses.
- [ ] Add or retain a small-limit regression (`maxTurns: 1`) proving the existing tool-turn enforcement and final-answer slack semantics still apply. Do not redefine a turn or change slack constants to satisfy the test.
- [ ] Run focused integration and unchanged budgeting tests after a fresh test build:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-args repo-agent-command repo-agent-cli streamed-repo-agent-endpoint status-server-chat-repo-agent engine-turn-budget
```

- [ ] Run the broader backend and dashboard suites and required static checks, sequentially:

```powershell
npm test
node .\dist\test-runner\run-tests.js --dashboard
npm run typecheck
npm run lint
npm --prefix dashboard run build
```

`npm run typecheck` currently invokes lint internally; still run the explicitly required standalone lint command. Use captured log files in the single scratch directory for large output, inspect exit codes and final summaries, and narrow failing diagnostics with `rg`. Do not pipe output into SiftKit. Record failures even if unrelated; never report a failing suite as green.

- [ ] Inspect the rendered UI in the browser: default pill beside access pills, 1000/10000 editing, preset default/reset, invalid input, session switching, narrow viewport wrapping, and busy-state disabling. Use existing local app/test infrastructure. A real 10,000-turn model run is not required or authorized by this plan; deterministic request/endpoint tests validate that limit.
- [ ] Review the final changed-file list and scoped diff. Confirm no changes to `turn-budget.ts`, compaction logic, runtime turn defaults, approval semantics, or unrelated user work. Verify CLI help and README agree.
- [ ] Remove only execution-created scratch files after validating the resolved scratch path is inside the intended workspace directory. Preserve this plan and all unrelated files.
- [ ] Report changed files, test/build/typecheck/lint results, browser verification, and any unverified scope. Do not commit.

## Final acceptance checklist

- [ ] `-turns 1000` and `-turns 10000` work through the real CLI request path.
- [ ] Omitted CLI override preserves backend default resolution.
- [ ] Bad or duplicate CLI options fail clearly without starting a run.
- [ ] Web UI exposes the control beside access pills and accurately displays override/preset/default precedence.
- [ ] Reset clears the override; session switching preserves independent inputs within the mounted dashboard.
- [ ] Invalid UI input cannot submit through buttons, retry, or direct hook calls and does not consume drafts/images.
- [ ] Active runs retain their original limit; their approval controls and Stop behavior remain intact.
- [ ] Large limits arrive intact at engine progress/result boundaries using deterministic tests.
- [ ] Existing context-budget and compaction behavior remains unchanged.
- [ ] Focused tests, broad suites, typecheck, lint, dashboard build, and visual checks are reported accurately.
- [ ] No SiftKit use, worktrees, commits, compatibility paths, or leftover temporary artifacts.
