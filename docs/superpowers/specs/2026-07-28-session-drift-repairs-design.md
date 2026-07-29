# Session Drift Repairs Design

**Date:** 2026-07-28

## Context

The strict-preset refactor introduced three remaining quality drifts:

1. Chat phase timestamps are tracked by separate implementations in the chat route and repo-operation runner.
2. The new model-queue race E2Es repeat temporary-repository, environment, server, session, and lock-holder setup.
3. The race E2Es were run green without recording the required red results under their corresponding production mutations.

The repairs must preserve current behavior. They must remove duplication completely, keep dependencies explicit, and leave persistent verification evidence.

## Goals

- Give chat phase timestamp state and transitions one production owner.
- Give model-queue E2E lifecycle and synchronization one reusable test owner.
- Prove both race E2Es detect the regressions they characterize.
- Preserve the route, telemetry, persistence, HTTP, and SSE contracts.
- Maintain fully inferred TypeScript without casts, `any`, non-null assertions, namespace imports, dynamic function passing, shims, or legacy compatibility.

## Non-Goals

- Changing timestamp semantics or telemetry schemas.
- Moving unrelated dashboard status-server tests to the new harness.
- Generalizing `ProgressWriter` with phase tracking.
- Building a generic test-server framework.
- Adding a mutation-testing dependency or permanent mutated source files.

## Architecture

### Shared chat phase tracker

Create `src/status-server/chat-turn-phase-tracker.ts` with:

```ts
export type ChatTurnPhaseTimestamps = {
  requestStartedAtUtc: string;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
};

export class ChatTurnPhaseTracker {
  constructor(requestStartedAtUtc?: string);
  observeThinking(content: string): void;
  observeAnswer(content: string): void;
  snapshot(): ChatTurnPhaseTimestamps;
}
```

The constructor uses the supplied request start time when the route already owns it and creates one when the repo-operation runner does not. Empty or whitespace-only content does not change state. The first non-empty event sets the corresponding start timestamp; every non-empty event updates its end timestamp. `snapshot()` returns the current values.

`routes/chat.ts` constructs this class in place of `createChatTurnPhaseTracker`. `chat-repo-operation-runner.ts` composes the same class inside `ChatRepoOperationProgressTracker`, delegates observation and snapshots to it, and retains responsibility only for forwarding progress events.

Both local `ChatTurnPhaseTimestamps` declarations and the route factory are removed. The shared module becomes the only timestamp transition implementation.

### Dedicated model-queue test harness

Create `tests/helpers/dashboard-model-queue-harness.ts` with one exported `DashboardModelQueueHarness` class. It owns:

- Creation of one temporary dashboard repository.
- Dashboard-specific environment setup and restoration.
- Status-server startup and shutdown.
- Runtime database closure and temporary-directory cleanup.
- The bound `baseUrl`.
- Chat session creation for queue scenarios.
- Polling until a specified model-request kind is active or queued.
- Starting a deterministic repo-search request that holds the model lock for a supplied delay.

The class exposes explicit methods rather than accepting callbacks:

```ts
export class DashboardModelQueueHarness {
  constructor(tempDirectoryPrefix: string);
  start(): Promise<void>;
  getBaseUrl(): string;
  createChatSession(title: string, model: string): Promise<string>;
  waitForActiveRequest(kind: string): Promise<void>;
  waitForQueuedRequest(kind: string): Promise<void>;
  holdModelLock(prompt: string, delayMs: number): Promise<SseResponse>;
  close(): Promise<void>;
}
```

Methods that require a running server fail clearly if called before `start()`. `close()` restores process state and removes temporary files even after a test assertion fails.

The two queue-race E2Es retain their scenario-specific HTTP actions and assertions:

- The Plan test deletes its queued session and asserts `404` without recreation.
- The Repo Search test aborts its queued request and asserts the session remains unchanged.

Only these queue-race tests move to the harness in this repair. Existing unrelated status-server tests remain unchanged.

## Data Flow

### Phase timestamps

1. A route or runner constructs `ChatTurnPhaseTracker`.
2. Thinking and answer events call the corresponding explicit observation method.
3. The tracker ignores empty content and updates its owned timestamp state for non-empty content.
4. The consumer reads a snapshot when writing telemetry.

### Queue-race E2Es

1. The test constructs and starts `DashboardModelQueueHarness`.
2. The harness creates a chat session and starts a repo-search lock holder.
3. The test waits through the harness until the holder is active.
4. The test starts its scenario-specific request and waits until it is queued.
5. The test performs deletion or disconnection and checks the externally visible result.
6. The test closes the harness in `finally`.

## Error Handling and Cleanup

- Tracker methods have no recoverable error path; they only normalize content emptiness and update state.
- Harness lifecycle misuse throws an explicit error rather than relying on a non-null assertion.
- Harness cleanup closes the server, restores the working directory, closes the runtime database, restores every changed environment variable, and removes the temporary root.
- Cleanup remains safe after a failed assertion. No temporary mutation or test file survives validation.

## Testing Strategy

### Shared tracker TDD

Add `tests/chat-turn-phase-tracker.test.ts` before the production module exists. The first focused run must fail because the shared class is missing. The tests cover:

- An initial snapshot with only `requestStartedAtUtc`.
- Whitespace-only thinking and answer content leaving all phase timestamps null.
- First non-empty thinking and answer events setting starts and ends.
- Later non-empty events retaining start timestamps while refreshing end timestamps.

After implementing and migrating both consumers, run the tracker test and the existing telemetry E2Es green.

### Harness refactor

Keep the two existing queue-race E2Es green while replacing repeated setup with the harness. Their HTTP outcomes and persistence assertions remain unchanged. No compatibility wrapper retains the duplicated setup.

### Mutation proof

Perform two controlled, temporary source mutations sequentially:

1. Remove the post-lock session reload used by queued Plan requests. Run the focused Plan race E2E and require a failure showing the deleted session is not rejected correctly.
2. Restore the source, remove the queued-request disconnect drop in `acquireModelRequestWithWait`, run the focused Repo Search race E2E, and require a failure showing the disconnected request proceeds or mutates state.

Restore each source change immediately after its red run. Run both focused E2Es green together. Record the commands, failing test names, failure causes, and final green result under Task 4 of `docs/superpowers/plans/2026-07-28-strict-preset-drift-remediation.md`.

### Completion gates

- Focused tracker test passes.
- Focused telemetry tests pass.
- Both focused queue-race E2Es pass after mutation restoration.
- `npm test -- dashboard-status-server` passes.
- Full test suite passes.
- Typecheck, lint, and build pass.
- Branch coverage does not regress and remains as close to 100% as the project permits.
- Repository search confirms one `ChatTurnPhaseTimestamps` type and one phase-transition implementation.
- No forbidden TypeScript constructs, compatibility paths, or temporary files remain.

## Implementation Order

1. Add the failing shared-tracker test.
2. Add the shared tracker and migrate both production consumers.
3. Add the dedicated queue harness and refactor the two race E2Es.
4. Run and document both controlled mutation proofs.
5. Run all completion gates and review the final diff for duplication and forbidden constructs.

