# Chat-Reachable Repo-Agent + Native In-Chat Approvals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per repo policy, dispatch `siftkit repo-agent` with 1-3 tasks at a time.

**Status:** LOCKED 2026-08-30 — validated against the codebase, mockup approved by the user (Approve / Reject-with-reason / Abort; resolved decisions collapse to compact audit rows). Do not re-open design decisions during execution.

**AMENDMENT 2026-08-30 (user decision):** Chat-launched operations (plan / repo-search / repo-agent) now **inherit the chat conversation context** instead of running fresh. Inherited context = exactly what a chat turn would see: the `buildChatHistoryMessages` replay (compaction summary + post-compaction messages). Operations keep their **own** preset/system prompt — only conversation history is inherited. Standalone runs (CLI/API, no session) remain contextless. Task 2 implements this; Tasks 3-4 thread history through the repo-agent path.

**Goal:** Start a repo-agent run from the chat composer, surface approval requests as inline chat bubbles with Approve / Reject / Abort, and persist the run result + approval audit rows into the session transcript.

**Architecture:** A new `StreamChatRepoAgentEndpoint extends ChatSessionOperationEndpoint` reuses the existing `RepoAgentSession` pipeline in **interactive** mode. Key verified fact that shapes everything: in interactive mode, `approval_request` is delivered as a **progress event** (`repo-agent-sessions.ts:255-272`) and `waitForBoundary` resolves **only at terminal states** (`repo-agent-sessions.ts:387-398`). So the chat endpoint holds one SSE stream + the session-operation lease for the entire run, translating progress into the existing chat SSE dialect plus one new `approval` event. A session-scoped decide endpoint submits decisions via `session.submitDecision`; decisions are collected in-memory and persisted with the user/assistant pair at run end.

**Tech Stack:** TypeScript, zod (`@siftkit/contracts`), node:test, React dashboard (plain CSS tokens).

**UI reference:** `.scratch/repo-agent-approval-mockup.html` (matches dashboard tokens from `dashboard/src/styles/global.css:1-6`; approval bubble fields mirror `RepoAgentApprovalSchema`).

**Verified design decisions (do not re-litigate during implementation):**
- Chat-launched approval default: `interactive`. (`auto` would make `approval_required` a stream boundary — `repo-agent-sessions.ts:394-396` — ending the chat stream mid-run.)
- Lease held for the entire run; released by `ChatSessionOperationEndpoint.handle`'s `finally` (`chat-session-operation-endpoint.ts:162-168`) after the terminal boundary resolves.
- Do **NOT** call `acquireModelRequestWithWait` in the chat agent endpoint. `RepoAgentSession.run()` acquires the model lock itself via the locks adapter (`repo-agent-sessions.ts:291`); double-locking deadlocks.
- Session↔run binding lives in an in-memory `Map` on `ServerContext` (no `sessionId` added to run-store schemas — avoids persisted-state migration). Known accepted edge: server restart mid-run orphans the binding; the run continues standalone and the transcript does not get the result.
- Result message reuses the existing `assistant_answer` kind (with `sourceRunId = runId`); only ONE new persisted kind is added: `repo_agent_approval`.
- Client disconnect mid-run must NOT abort persistence: keep awaiting the terminal boundary (no abort signal on `waitForBoundary`), persist, then end the (possibly dead) SSE writer.
- **Stop control (user decision 2026-08-30):** while THIS client's operation holds the session lease and is queued/generating, the composer send button becomes a **Stop** button (danger style) instead of being grayed out. Stop = explicit server-side abort (`POST .../stop`), NOT a client disconnect: the server aborts the generation, persists ("flushes") whatever partial work exists plus a "Stopped by user." marker into the transcript, releases the model lock so the next queued request proceeds, and ends the stream with a normal `done`. Tasks 9-10.

---

### Task 1: Contracts — operation kind, approval stream event, persisted approval kind

**Files:**
- Modify: `packages/contracts/src/chat.ts` (enum at `:151`, unions at `:107-118`)
- Test: `tests/contracts-chat-repo-agent.test.ts` (create; mirror the import style of an existing test that imports `@siftkit/contracts`)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatSessionOperationKindSchema,
  ChatSessionBusyResponseSchema,
  ChatStreamApprovalSchema,
  PersistedChatMessageSchema,
} from '@siftkit/contracts';

test('operation kind accepts repo-agent', () => {
  assert.equal(ChatSessionOperationKindSchema.parse('repo-agent'), 'repo-agent');
});

test('busy response parses with repo-agent kind', () => {
  const parsed = ChatSessionBusyResponseSchema.parse({
    error: 'Chat session already has an active operation.',
    sessionId: 's1',
    operationKind: 'repo-agent',
  });
  assert.equal(parsed.operationKind, 'repo-agent');
});

test('approval stream payload parses', () => {
  const parsed = ChatStreamApprovalSchema.parse({
    runId: '4f9c1f9a-0000-4000-8000-000000000000',
    approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
    toolName: 'bash',
    command: 'node --test tests/x.test.ts',
    reviewPayload: null,
  });
  assert.equal(parsed.toolName, 'bash');
});

test('repo_agent_approval persisted message parses and old kinds still load', () => {
  const approval = PersistedChatMessageSchema.parse({
    id: 'm1', role: 'user', kind: 'repo_agent_approval',
    content: 'approved bash: node --test tests/x.test.ts',
    createdAtUtc: new Date().toISOString(),
    approvalDecision: 'approve', approvalToolName: 'bash',
    approvalCommand: 'node --test tests/x.test.ts', approvalReason: null,
  });
  assert.equal(approval.kind, 'repo_agent_approval');
  const legacy = PersistedChatMessageSchema.parse({
    id: 'm2', role: 'user', kind: 'user_text', content: 'hi',
    createdAtUtc: new Date().toISOString(),
  });
  assert.equal(legacy.kind, 'user_text');
});
```

Adjust the object literals to satisfy required `ChatMessageBaseSchema` fields (read `packages/contracts/src/chat.ts:55-77` first; add any required base fields the test objects are missing).

- [ ] **Step 2: Run it — expect FAIL** (`ChatStreamApprovalSchema` not exported; `repo-agent` not in enum)

Run: `node --test tests/contracts-chat-repo-agent.test.ts`

- [ ] **Step 3: Implement in `packages/contracts/src/chat.ts`**

At `:151` add `'repo-agent'`:

```ts
export const ChatSessionOperationKindSchema = z.enum(['message', 'plan', 'repo-search', 'repo-agent', 'condense']);
```

After `ChatToolCallMessageSchema` (`:90`) add:

```ts
export const ChatRepoAgentApprovalMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('user'),
  kind: z.literal('repo_agent_approval'),
  approvalDecision: z.enum(['approve', 'deny', 'abort']),
  approvalToolName: z.string().min(1),
  approvalCommand: z.string().min(1),
  approvalReason: z.string().nullable(),
});
export type ChatRepoAgentApprovalMessage = z.infer<typeof ChatRepoAgentApprovalMessageSchema>;
```

Add it to BOTH discriminated unions (`PersistedChatMessageSchema` `:107-110` and `LiveChatMessageSchema` `:113-117`).

Near `ChatStreamProgressSchema` (`:167`) add:

```ts
export const ChatStreamApprovalSchema = z.object({
  runId: z.string().uuid(),
  approvalId: z.string().uuid(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});
export type ChatStreamApproval = z.infer<typeof ChatStreamApprovalSchema>;
```

- [ ] **Step 4: Rebuild contracts if the package has a build step, run the test — expect PASS**
- [ ] **Step 5: Run `npm run typecheck`.** The widened enum may surface exhaustive-switch errors (dashboard busy handling, metrics). Fix every site the compiler reports — this sweep is the point of doing contracts first.

---

### Task 2: Chat-launched plan/repo-search inherit chat context (history pass-through)

**Files:**
- Modify: `src/status-server/chat-repo-operation-runner.ts` (engine request built at `:150-167`)
- Modify: `src/repo-search/execute.ts:408` (history gate)
- Test: `tests/chat-repo-operation-runner.test.ts` (engine-request stub already records requests at `:42-91`)
- Test: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Write the failing runner test** — build a session containing: a `compaction_summary` message, a pre-compaction message marked `compressedIntoSummary: true`, and a post-compaction user/assistant pair. For both `runPlan` and `runRepoSearch`, assert the recorded `executeRepoSearch` request's `history` deep-equals `buildChatHistoryMessages(...)` for that session — i.e., the compressed message is absent, the summary and post-compaction messages are present. Also assert NO `systemPrompt` key (operations keep their own preset prompt).
- [ ] **Step 2: Run — expect FAIL** (`history` is currently not passed): `node --test tests/chat-repo-operation-runner.test.ts`
- [ ] **Step 3: Implement in `ChatRepoOperationRunner.run`** — read `buildChatHistoryMessages`'s exact signature at `src/status-server/chat.ts:310` (export it from `chat.ts` if not already exported) and pass the replay into the engine request built at `chat-repo-operation-runner.ts:150-167`:

```ts
engineResult = await request.engineService.executeRepoSearch({
  presetId: selected.preset.id,
  taskKind: operation,
  prompt: this.buildPrompt(operation, request.content),
  history: buildChatHistoryMessages(/* session + the options chat itself uses */),
  ...
});
```

Use the same options the chat message path uses (thinking replay flag etc.) so chat and chat-launched operations see identical context.

- [ ] **Step 4: Open the engine gate.** Change `src/repo-search/execute.ts:408` from

```ts
historyMessages: taskKind === 'chat' ? (request.history || []) : undefined,
```

to

```ts
historyMessages: request.history ?? (taskKind === 'chat' ? [] : undefined),
```

Supplied history is now honored for every task kind; callers that pass nothing (all standalone paths) are byte-for-byte unchanged. Leave `:409` (`thinkingEnabledOverride`) chat-only.

- [ ] **Step 5: Add the engine-gate tests** in `tests/repo-search-chat-execute.test.ts`: (a) `taskKind: 'repo-search'` + supplied `history` → model call receives that `historyMessages`; (b) `taskKind: 'repo-search'` + no `history` → `historyMessages: undefined` (standalone unchanged).
- [ ] **Step 6: Run both files + `npm run typecheck` — expect PASS:** `node --test tests/chat-repo-operation-runner.test.ts tests/repo-search-chat-execute.test.ts`

---

### Task 3: Extract `startRepoAgentRun` helper (pure refactor)

**Files:**
- Modify: `src/status-server/routes/repo-agent.ts:54-103`

- [ ] **Step 1: Extract lines 55-102 of `RepoAgentStartEndpoint.handle`** into an exported function; the endpoint becomes a thin caller:

```ts
export type StartRepoAgentRunInput = {
  prompt: string;
  repoRoot: string | undefined;
  approvalMode: ApprovalMode;
  model?: string | null;
  maxTurns?: number;
  logFile?: string;
  images?: string[];
  promptPrefix?: string;
  /** Chat-launched runs pass the session's replayed conversation; standalone callers omit it. */
  history?: RepoSearchExecutionRequest['history'];
  availableModels?: string[];
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
};

export function startRepoAgentRun(ctx: ServerContext, input: StartRepoAgentRunInput): {
  runId: string;
  session: RepoAgentSession;
  admission: RepoSearchAdmissionRecord;
} {
  // body = existing :56-102 verbatim, using input.* instead of the parsed body,
  // returning { runId, session, admission } instead of streaming.
  // engineRequest additionally spreads `...(input.history === undefined ? {} : { history: input.history })`
  // — RepoAgentEngineRequest already admits it (Omit of RepoSearchExecutionRequest keeps `history`).
}
```

`RepoAgentStartEndpoint.handle` keeps its parsing/guard (`:34-53`), then:

```ts
const { session } = startRepoAgentRun(ctx, {
  prompt: input.prompt, repoRoot: input.repoRoot,
  approvalMode: input.approval ?? 'auto',
  model: input.model, maxTurns: input.maxTurns, logFile: input.logFile,
  images: input.images, promptPrefix: input.promptPrefix,
  availableModels: input.availableModels,
  mockResponses: input.mockResponses, mockCommandResults: input.mockCommandResults,
});
await streamSessionBoundary(session, req, res, 0);
```

- [ ] **Step 2: Run the existing repo-agent route tests** (locate with `siftkit repo-search "which test files exercise POST /repo-agent and RepoAgentStartEndpoint"` if not obvious from `tests/repo-agent*`), plus `npm run typecheck`. Expect green — behavior unchanged.

---

### Task 4: Server — chat run binding + `StreamChatRepoAgentEndpoint`

**Files:**
- Create: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `src/status-server/server-types.ts` (add `chatRepoAgentRuns` to `ServerContext`), plus every `ServerContext` construction site (grep `repoAgentSessions:` to find them, including test harnesses)
- Modify: `src/status-server/routes/chat.ts:1465-1481` (route registration)
- Modify: `src/status-server/chat.ts` (persistence + markdown builder + replay branch)
- Test: `tests/status-server-chat-repo-agent.test.ts` (create; mirror the harness of the existing repo-agent route tests, which drive runs with `mockResponses`/`mockCommandResults`)

- [ ] **Step 1: Write the failing route test** — POST `/dashboard/chat/sessions/:id/repo-agent/stream` with `{ content, repoRoot, mockResponses }` on a real session file. Assert:
  1. Response is SSE ending with a `done` event whose payload parses as a chat session response.
  2. The persisted session gained a `user_text` message (content = draft) and an `assistant_answer` with `sourceRunId` set.
  3. The engine request recorded by the mock has `taskKind: 'repo-agent'`, `prompt` = draft, and `history` deep-equal to the session's `buildChatHistoryMessages` replay (seed the session with a prior user/assistant pair and assert both appear; pins context inheritance for the new path). Also add a standalone-start assertion (existing `POST /repo-agent` tests): engine request has NO `history` key.
  4. A concurrent POST to `/messages/stream` during the run gets 409 with `operationKind: 'repo-agent'`.
- [ ] **Step 2: Run — expect FAIL (404, route missing).**
- [ ] **Step 3: Add the binding registry.** In `server-types.ts`, on `ServerContext`:

```ts
chatRepoAgentRuns: Map<string, ChatRepoAgentRunBinding>;
```

with the type exported from the new route file:

```ts
export type ChatRepoAgentDecisionRecord = {
  decision: 'approve' | 'deny' | 'abort';
  reason: string | null;
  approval: RepoAgentApproval;
  decidedAtUtc: string;
};
export type ChatRepoAgentRunBinding = {
  runId: string;
  decisions: ChatRepoAgentDecisionRecord[];
};
```

Initialize `chatRepoAgentRuns: new Map()` at every context construction site.

- [ ] **Step 4: Implement the endpoint** in `src/status-server/routes/chat-repo-agent.ts`:

```ts
type ChatRepoAgentRequest = ResolvedChatRepoRequest & {
  approval: ApprovalMode;
  maxTurns?: number;
};

export class StreamChatRepoAgentEndpoint extends ChatSessionOperationEndpoint<ChatRepoAgentRequest> {
  protected readonly operationKind = 'repo-agent' as const;

  protected parseRequest(res, session, parsedBody): ChatRepoAgentRequest | null {
    const base = parseChatRepoOperationRequest(res, session, parsedBody);
    if (!base) { return null; }
    const approval = ApprovalModeSchema.optional().safeParse(parsedBody['approval']);
    if (!approval.success) {
      sendJson(res, 400, { error: 'approval must be one of: interactive, auto, off.' });
      return null;
    }
    const maxTurns = z.number().int().positive().optional().safeParse(parsedBody['maxTurns']);
    if (!maxTurns.success) {
      sendJson(res, 400, { error: 'maxTurns must be a positive integer.' });
      return null;
    }
    return { ...base, approval: approval.data ?? 'interactive', maxTurns: maxTurns.data };
  }

  protected async run(ctx, req, res, request): Promise<void> {
    if (rejectNestedAgentSelfCall(ctx, req, res, 'repo-search')) { return; }
    const config = readConfig(ctx.configPath);
    const activeSession = readChatSessionFromPath(request.sessionPath); // re-read for fresh history, like plan/stream does (chat.ts:1234)
    if (!activeSession) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const started = startRepoAgentRun(ctx, {
      prompt: request.value.content,
      repoRoot: request.value.repoRoot,
      approvalMode: request.value.approval,
      images: request.value.images,
      maxTurns: request.value.maxTurns,
      history: buildChatHistoryMessages(/* activeSession + the same options Task 2 uses */),
      mockResponses: readRouteMockResponses(new JsonRecordReader(request.parsedBody), 'mockResponses'),
      // mockCommandResults: parse from parsedBody the same way the standalone start route does
    });
    const binding: ChatRepoAgentRunBinding = { runId: started.runId, decisions: [] };
    ctx.chatRepoAgentRuns.set(request.sessionId, binding);
    const sse = new SseResponseWriter(req, res);
    sse.open();
    const progressWriter = new ChatStreamProgressWriter(sse, null, 'repo-search', started.admission.requestId, false);
    const detach = started.session.attach({
      writeProgress: (event) => {
        if (event.kind === 'approval_request') {
          sse.writeEvent('approval', {
            runId: started.runId,
            approvalId: event.approvalId,
            toolName: event.toolName,
            command: event.command,
            reviewPayload: event.reviewPayload ?? null,
          });
          return;
        }
        if (event.kind === 'lock_wait') { return; }
        progressWriter.write(event);
      },
    });
    try {
      // Deliberately NO abort signal: a dead browser must not stop persistence.
      const result = await started.session.waitForBoundary(0);
      const updatedSession = appendChatRepoAgentMessages(getRuntimeRoot(), request.sessionId, {
        content: request.value.content,
        images: request.value.images,
        decisions: binding.decisions,
        result,
      });
      progressWriter.flushPending();
      sse.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      progressWriter.flushPending();
      sse.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      detach();
      ctx.chatRepoAgentRuns.delete(request.sessionId);
      sse.end();
    }
  }
}
```

Type note: the subscriber receives `OperationProgressEvent`; narrow `approval_request` / `lock_wait` by `kind` (valid discriminant narrowing — no casts). If `ChatStreamProgressWriter.write` takes `RepoSearchProgressEvent`, the post-narrowing type must already fit; if the compiler disagrees, write an explicit `kind`-switch mapping instead of asserting.

- [ ] **Step 5: Persistence + markdown in `src/status-server/chat.ts`.** Read `appendChatMessagesWithUsage` first and reuse the same message-construction and save helpers it uses. Add:

```ts
export function buildRepoAgentResultMarkdown(result: RepoAgentRunResult): string {
  switch (result.status) {
    case 'completed': return result.output;
    case 'failed': return `Repo-agent run failed: ${result.error}${result.output ? `\n\n${result.output}` : ''}`;
    case 'aborted': return 'Repo-agent run stopped by user.';
    case 'approval_timeout':
      return `Repo-agent run timed out waiting for approval of \`${result.approval.command}\`.`;
    case 'approval_required':
      throw new Error('approval_required is not terminal for interactive chat runs.');
  }
}

export function appendChatRepoAgentMessages(runtimeRoot: string, sessionId: string, input: {
  content: string;
  images: string[];
  decisions: ChatRepoAgentDecisionRecord[];
  result: RepoAgentRunResult;
}): ChatSession {
  // Order: user_text (content + images) → one repo_agent_approval row per decision → assistant_answer.
  // approval row: role 'user', content `${decision} ${toolName}: ${command}` (+ ` — ${reason}` for deny),
  //   approvalDecision/approvalToolName/approvalCommand/approvalReason from the record.
  // assistant_answer: content = buildRepoAgentResultMarkdown(result), sourceRunId = result.runId.
  // Persist through the same session read→append→write helper appendChatMessagesWithUsage uses,
  // and return the re-read authoritative session (pattern: chat-repo-operation-runner.ts:317-323).
}
```

- [ ] **Step 6: Replay branch.** In `buildChatHistoryMessages` (`src/status-server/chat.ts:310-368`) add, before the default branch:

```ts
if (kind === 'repo_agent_approval') {
  history.push({ role: 'user', content: `[repo-agent approval] ${message.content}` });
  pendingThinking = null;
  continue;
}
```

(Match the loop's actual local-variable idiom at `:320-365`.)

- [ ] **Step 7: Register the route** in `CHAT_ROUTES` (`routes/chat.ts:1465-1481`):

```ts
{ method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/stream$/u, endpoint: new StreamChatRepoAgentEndpoint() },
```

- [ ] **Step 8: Run the new test — expect PASS.** Also rerun Task 2's tests and the standalone repo-agent tests (unchanged behavior).
- [ ] **Step 9: Commit** (only when the user has asked for commits; otherwise leave staged-nothing per repo policy).

---

### Task 5: Server — session-scoped decide + active-run endpoints

**Files:**
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `src/status-server/routes/chat.ts` (two more routes)
- Test: `tests/status-server-chat-repo-agent.test.ts`

- [ ] **Step 1: Write failing tests** (interactive run driven by mocks that request one approval):
  1. Start a run; wait for the `approval` SSE event; POST `/dashboard/chat/sessions/:id/repo-agent/decide` `{ decision: 'approve' }` → 200 `{ ok: true, runId }`; stream continues to `done`; persisted session contains one `repo_agent_approval` row with `approvalDecision: 'approve'` between the `user_text` and `assistant_answer`.
  2. Same with `{ decision: 'deny', reason: 'wrong file' }` → row has `approvalReason: 'wrong file'`.
  3. `{ decision: 'abort' }` → run terminal `aborted`; assistant_answer says aborted.
  4. Decide with no active binding → 409; decide when state is not `approval_required` → 409.
  5. GET `/dashboard/chat/sessions/:id/repo-agent/active` during the parked approval → 200 `{ runId, state }` with `state.status === 'approval_required'`; after `done` → 404.
- [ ] **Step 2: Run — expect FAIL (404s).**
- [ ] **Step 3: Implement decide** (plain `RouteEndpoint` — it must run while the main op holds the lease, so no lease; still parses the session id from the route captures like `readChatSessionIdFromMatch`):

```ts
export class ChatRepoAgentDecideEndpoint implements RouteEndpoint {
  async handle(ctx, req, res, match): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const parsedBody = parseJsonBody(await readBody(req)); // wrap with the standard sendBodyReadError guard
    const parsed = RepoAgentDecisionSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected decision (approve|deny|abort) and a reason for deny.' });
      return;
    }
    const binding = ctx.chatRepoAgentRuns.get(sessionId);
    if (!binding) {
      sendJson(res, 409, { error: `Session ${sessionId} has no active repo-agent run.` });
      return;
    }
    const session = ctx.repoAgentSessions.get(binding.runId);
    if (!session) {
      sendJson(res, 404, { error: `Unknown repo-agent run ${binding.runId}.` });
      return;
    }
    const state = session.getState();
    if (state.status !== 'approval_required') {
      sendJson(res, 409, { error: `Run ${binding.runId} has no pending approval.` });
      return;
    }
    const approval = state.approval;
    if (!session.submitDecision({ ...parsed.data, runId: binding.runId })) {
      sendJson(res, 409, { error: `Run ${binding.runId} has no pending approval.` });
      return;
    }
    binding.decisions.push({
      decision: parsed.data.decision,
      reason: parsed.data.decision === 'deny' ? parsed.data.reason : null,
      approval,
      decidedAtUtc: new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true, runId: binding.runId });
  }
}
```

- [ ] **Step 4: Implement active-run GET** (plain `RouteEndpoint`, no body):

```ts
export class GetChatRepoAgentActiveEndpoint implements RouteEndpoint {
  async handle(ctx, _req, res, match): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const binding = ctx.chatRepoAgentRuns.get(sessionId);
    const session = binding ? ctx.repoAgentSessions.get(binding.runId) : undefined;
    if (!binding || !session) {
      sendJson(res, 404, { error: 'No active repo-agent run for this session.' });
      return;
    }
    sendJson(res, 200, { runId: binding.runId, state: session.getState() });
  }
}
```

- [ ] **Step 5: Register both routes:**

```ts
{ method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/decide$/u, endpoint: new ChatRepoAgentDecideEndpoint() },
{ method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/active$/u, endpoint: new GetChatRepoAgentActiveEndpoint() },
```

- [ ] **Step 6: Run tests — expect PASS.** Then `npm run typecheck`.

---

### Task 6: Dashboard — stream plumbing (api, parser, transitions, runtime store)

**Files:**
- Modify: `dashboard/src/api.ts` (after `:545`)
- Modify: `dashboard/src/lib/chat-stream-parser.ts` (event switch `:48-79`, kinds `:15-23`)
- Modify: `dashboard/src/lib/chat-stream-transitions.ts` (`:10-50`)
- Modify: the runtime store that `setRuntimeStore(...).apply(transition)` drives (follow `toRuntimeTransitions` imports from `useChatSessions.ts:342`)
- Modify: `dashboard/src/hooks/useChatSessions.ts` (after `sendRepoSearch`, `:424-437`)
- Test: extend the existing dashboard test suites for the parser/transitions (find siblings of `dashboard/tests/chat-tab.test.tsx`)

- [ ] **Step 1: Failing parser test:** an SSE packet `event: approval` with a valid `ChatStreamApproval` payload parses to `{ kind: 'approval', approval: {...} }`; malformed payload → parse error consistent with the file's existing zod handling.
- [ ] **Step 2: Implement:**
  - `api.ts`:

```ts
export function streamRepoAgentMessage(
  sessionId: string,
  payload: { content: string; images?: string[]; repoRoot?: string; approval?: 'interactive' | 'auto' | 'off'; maxTurns?: number },
): AsyncGenerator<ChatStreamEvent> {
  return consumeChatStream(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-agent/stream`,
    payload,
  );
}

export async function decideRepoAgent(
  sessionId: string,
  decision: { decision: 'approve' } | { decision: 'deny'; reason: string } | { decision: 'abort' },
): Promise<{ ok: true; runId: string }> {
  // POST JSON to /dashboard/chat/sessions/:id/repo-agent/decide using this file's
  // existing non-stream fetch/parse helper; validate the response with a zod schema.
}

export async function getActiveRepoAgentRun(sessionId: string): Promise<{ runId: string; state: JsonValue } | null> {
  // GET .../repo-agent/active; 404 → null.
}
```

  - `chat-stream-parser.ts`: add `'approval'` to the event-name switch, validating with `ChatStreamApprovalSchema`, producing kind `'approval'`.
  - `chat-stream-transitions.ts`: map `approval` events to an `{ kind: 'approval', sessionId, approval }` transition.
  - Runtime store: add `pendingApproval: ChatStreamApproval | null` to the per-session runtime; `approval` transition sets it; `done` / `failure` / `submit` clear it.
  - `useChatSessions.ts`: add

```ts
async function sendRepoAgent(): Promise<void> {
  const session = requireSelectedSession(selectedSession);
  const inputs = readRuntimeInputs(session.id);
  if (!inputs.draft) { return; }
  submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
  await runChatStream(session.id, 'repo-agent', streamRepoAgentMessage(session.id, {
    content: inputs.draft,
    images: inputs.pendingImages.map((image) => image.dataUrl),
    repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
    ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
  }));
}

async function submitRepoAgentDecision(decision: Parameters<typeof decideRepoAgent>[1]): Promise<void> {
  const session = requireSelectedSession(selectedSession);
  await decideRepoAgent(session.id, decision);
  // clear pendingApproval in the runtime store via a transition/apply call matching the store's idiom
}
```

  Export both from the hook's return object.
- [ ] **Step 3: Run dashboard tests + `npm run typecheck` — expect PASS.**

---

### Task 7: Dashboard — composer mode + approval bubble UI

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx` (`getSendLabel` `:140-145`, `dispatchSend` `:285-289`, composer `:442-530`, turn rendering `:361-`)
- Modify: `dashboard/src/hooks/useChatController.ts:43-45`
- Create: `dashboard/src/components/RepoAgentApprovalCard.tsx`
- Modify: `dashboard/src/styles/chat.css` (approval styles)
- Test: `dashboard/tests/chat-tab.test.tsx`
- Reference: `.scratch/repo-agent-approval-mockup.html` (visual spec — pending/approved/denied/timeout states, deny-reason expansion, colors)

- [ ] **Step 0: Verify the preset family.** Check `getPresetFamily` / `DashboardPresetExecutionFamily` includes `'repo-agent'` (preset kind exists at `packages/contracts/src/config.ts:236`; the editor handles it at `dashboard/src/preset-editor.ts:68-84`). If the family type lacks it, add it and fix the resulting exhaustive switches.
- [ ] **Step 1: Failing UI test:** with a repo-agent-family session selected, the send button reads `Run Agent`; when the runtime has a `pendingApproval`, the transcript shows a card with the command text and Approve / Reject / Abort buttons; Reject requires a non-empty reason before submit is enabled; after a decision the card is replaced by a compact audit row.
- [ ] **Step 2: Implement:**
  - `getSendLabel`: add `if (chatMode === 'repo-agent') { return 'Run Agent'; }`.
  - `dispatchSend`: add `if (chatMode === 'repo-agent') { void onSendRepoAgent(); return; }`.
  - `useChatController.ts:45`: `const isRepoToolMode = chatMode === 'plan' || chatMode === 'repo-search' || chatMode === 'repo-agent';` (shows the repo-root row for agent sessions too).
  - `RepoAgentApprovalCard`: props `{ approval: ChatStreamApproval; onDecide(decision): void }`; render per the mockup (header `Approval required — {toolName}`, command block, reviewPayload line when non-null, Approve `.send`-styled, **Reject…** button that expands a required-reason textarea using the `.err-banner` palette, Abort ghost). UI label is "Reject"; the wire value stays `decision: 'deny'`.
  - Resolved decisions are **compact one-line audit rows, never cards**: on decision the pending card collapses to a row (`verdict · command · who · time · reason-if-rejected`), and persisted `repo_agent_approval` messages render as the same row using `approvalDecision`/`approvalCommand`/`approvalReason` (mockup class `.approval-row`).
  - `chat.css`: add `.approval-card` (pending) and `.approval-row` (resolved) rules; use existing tokens (`--run` amber border for pending, `--ok` left-border for approved rows, `--bad`/`#8d4b53` for rejected); copy exact values from the mockup's stylesheet.
- [ ] **Step 3: Run dashboard tests — expect PASS.**

---

### Task 8: Dashboard — reload recovery

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts` (session-select path)
- Test: dashboard test for the recovery hook path

- [ ] **Step 1: Failing test:** selecting a session for which `getActiveRepoAgentRun` returns `{ state: { status: 'approval_required', approval } }` populates `pendingApproval` in the runtime store.
- [ ] **Step 2: Implement:** on session select, call `getActiveRepoAgentRun(sessionId)`; if the state is `approval_required` or `approval_timeout`, set `pendingApproval` from `state.approval` (+ `runId`); otherwise clear it. Note the live progress stream is NOT re-attached in v1 — after reload the card is actionable but progress resumes only at the next persisted state.
- [ ] **Step 3: Run tests — expect PASS.**

---

### Task 9: Stop control — server-side abort + flush

**Files:**
- Modify: `src/status-server/chat-session-operation-registry.ts` (abort hook on the active-operation record)
- Modify: `src/status-server/repo-agent-sessions.ts` (public `abort()`)
- Modify: `src/status-server/routes/chat.ts` (stop route; abort plumbing in the message/plan/repo-search stream endpoints)
- Modify: `src/status-server/routes/chat-repo-agent.ts` (register agent abort)
- Test: `tests/status-server-chat-stop.test.ts` (create)

- [ ] **Step 0: Discovery (required before coding; capture answers as comments in the test file):**
  1. How `abortSignal` flows into `executeRepoSearch` for the chat message stream endpoint (`StreamChatMessageEndpoint`) — read its `run()` and the engine call site.
  2. Whether `ServerModelLockAdapter.acquire` / `acquireModelRequestWithWait` can be cancelled while queued (read `src/status-server/repo-agent-lock-adapter.ts` and the model-request lock helpers). If not cancellable, a Stop during queue-wait aborts immediately after the lock is granted — acceptable v1; note it.
  3. Where partial answer text accumulates server-side during a chat message stream (the progress/delta writer) — if accessible, persist it; if not, persist the marker only and note it.
  4. How an engine abort surfaces in `RepoAgentSession.run()`'s catch (`repo-agent-sessions.ts:324`) — confirm the mapping below turns it into `aborted`, not `failed`.
- [ ] **Step 1: Write the failing tests:**
  1. `POST /dashboard/chat/sessions/:id/stop` with no active operation → 409.
  2. Start a mocked slow repo-search stream; stop mid-run → 200 `{ ok: true, operationKind: 'repo-search' }`; the stream ends with a `done` event; the persisted session has the user message and an assistant message ending with `Stopped by user.`; the session lease is released (a follow-up chat message is NOT 409); the model lock is released (a queued request proceeds).
  3. Repo-agent run generating (not parked): stop → run store state `aborted`; transcript `assistant_answer` = `Repo-agent run stopped by user.`; `chatRepoAgentRuns` binding cleared.
  4. Repo-agent run parked at an approval: stop → same terminal `aborted` persistence (the gate observes the abort signal).
- [ ] **Step 2: Run — expect FAIL (404, route missing).**
- [ ] **Step 3: Registry abort hook.** In `chat-session-operation-registry.ts`: add `abort?: () => void` to the `ChatSessionOperation` record, plus:

```ts
registerAbort(lease: ChatSessionOperationLease, abort: () => void): boolean {
  const active = this.activeBySessionId.get(lease.sessionId);
  if (!active || active.token !== lease.token) { return false; }
  active.abort = abort;
  return true;
}

getActive(sessionId: string): ChatSessionOperation | undefined {
  return this.activeBySessionId.get(sessionId);
}
```

`ChatSessionOperationEndpoint` must expose its acquired lease to `run()` (add it to `ChatSessionOperationRequest`) so endpoints can register their abort.

- [ ] **Step 4: `RepoAgentSession.abort()`** in `repo-agent-sessions.ts`:

```ts
abort(): void {
  if (isTerminalStatus(this.state.status)) { return; }
  this.abortController.abort(new Error('Stopped by user.'));
}
```

In `run()`'s catch (`:324`), branch before `settleFailure`: when `this.abortController.signal.aborted` and the state is non-terminal, transition to `{ status: 'aborted', pid: process.pid, revision: +1, ... }` instead of `failed` (mirror `settleFailure`'s transition/fallback structure). The parked-approval case resolves through the gate's abort-signal handling; verify in step 0.4 and cover with test 4.

- [ ] **Step 5: Abort plumbing in the three chat stream endpoints** (`messages/stream`, `plan/stream`, `repo-search/stream`): create an `AbortController` per request, `registerAbort(lease, () => controller.abort())`, pass `controller.signal` as the engine request's `abortSignal`. In the catch path, when `controller.signal.aborted`: persist the turn (user content + any partial answer from step 0.3 + trailing `\n\n*Stopped by user.*`) through the same persistence helper the success path uses, then emit `done` with the updated session instead of `error`. The existing `finally` blocks already release the model lock (queue continues) and the lease.
- [ ] **Step 6: Agent endpoint registration.** In `StreamChatRepoAgentEndpoint.run()`: `ctx.chatSessionOperations.registerAbort(request.lease, () => started.session.abort())`. No other change — `waitForBoundary(0)` resolves with the `aborted` terminal result and the existing persistence path writes `Repo-agent run stopped by user.`
- [ ] **Step 7: Stop route** (plain `RouteEndpoint`, no lease, no body):

```ts
export class StopChatOperationEndpoint implements RouteEndpoint {
  async handle(ctx, _req, res, match): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const active = ctx.chatSessionOperations.getActive(sessionId);
    if (!active || !active.abort) {
      sendJson(res, 409, { error: 'No stoppable operation is active for this session.' });
      return;
    }
    active.abort();
    sendJson(res, 200, { ok: true, operationKind: active.operationKind });
  }
}
```

Register: `{ method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/stop$/u, endpoint: new StopChatOperationEndpoint() }`.

- [ ] **Step 8: Run tests + `npm run typecheck` — expect PASS.** Rerun the standalone repo-agent tests (the `abort()` addition must not change any existing path).

---

### Task 10: Stop control — UI stop button

**Files:**
- Modify: `dashboard/src/api.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/tabs/ChatTab.tsx` (send button `:515-522`), `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-tab.test.tsx`
- Reference: `.scratch/repo-agent-approval-mockup.html` (composer shows the Stop-button state)

- [ ] **Step 1: Failing test:** while the selected session's runtime shows an operation started by this client (streaming/tool indicator), the composer button reads `Stop` with danger styling and is enabled; clicking it POSTs to `/dashboard/chat/sessions/:id/stop`; when the stream's `done` arrives, the button reverts to the mode label (`Send` / `Run Agent` / …). When the session is busy from a 409 (another client's operation), the button stays the grayed-out mode label — Stop only appears for this client's own operation.
- [ ] **Step 2: Implement:**
  - `api.ts`: `stopChatOperation(sessionId)` → POST `.../stop`, zod-validate `{ ok: true, operationKind }`, surface 409 as the file's standard error type.
  - `useChatSessions.ts`: `stopOperation()` calling it for the selected session; export from the hook.
  - `ChatTab.tsx`: derive `isOwnOperationActive` from the selected runtime's indicator; when true render `<button className="send stop" onClick={...stopOperation}>Stop</button>` (enabled) in place of the disabled send button; textarea stays disabled.
  - `chat.css`: `.send.stop` reuses the danger palette (`runs.css:148-154` values — border `#8d4b53`, gradient `#3a2028 → #28161c`, text `#ffd7d2`); exact values in the mockup.
- [ ] **Step 3: Run dashboard tests — expect PASS.**

---

### Task 11: Docs — context-inheritance matrix

**Files:**
- Create: `docs/context-inheritance.md`

- [ ] **Step 1: Write the matrix:** chat turns AND all chat-launched operations (plan / repo-search / repo-agent) = the same `buildChatHistoryMessages` replay (`src/status-server/chat.ts:310-368`): latest compaction summary + post-compaction messages; rows marked `compressedIntoSummary` are omitted from model context but remain visible in the transcript UI, and each compaction summarizes history that included the previous summary (chained, `chat.ts:536-545`, `:772-777`). Operations keep their own preset/system prompt — only conversation history is inherited. Standalone runs (CLI/API, no session) = zero session context. Results + approval rows persist one-way into the transcript. Cite the tests from Tasks 2 and 4.

---

### Task 12: Full validation

- [ ] `npm run typecheck` and `npm run lint` — expect clean.
- [ ] Broad suite through siftkit (repo policy): `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."`
- [ ] Manual smoke against a dev server: create a repo-agent-preset session → Run Agent → approve one gate, deny another with a reason → run completes → transcript shows user prompt, two approval rows, result → send a normal chat message and confirm the model's reply references the agent's work → reload mid-run at a parked approval and confirm the card reappears and Approve still works. Then: start a run, hit **Stop** mid-generation → transcript shows the "Stopped by user." marker, composer unlocks, and a queued request from another session starts generating.
- [ ] Delete `.scratch/` artifacts once the mockup has served its purpose (repo policy: temporary artifacts removed at completion).

---

## Self-review notes

- Spec coverage: chat-reachable start (T4), native approvals (T5, T7), persistence + replay (T4 steps 5-6, T5 tests), context inheritance for chat-launched operations (T2, T4 test 3 — per the 2026-08-30 amendment; the original fresh-run contract is inverted), busy/409 semantics (T1, T4 test 4), reload recovery (T5 step 4, T8), stop control (T9-T10), standalone contextless + otherwise unchanged (T2 step 5b, T3, T4 test 3 standalone assertion), docs (T11).
- Known deviations from the original plan draft, all evidence-backed: no `sessionId` in run schemas (in-memory binding instead); no `streamSessionBoundary` reuse in chat (interactive-mode single stream via `attach` + `waitForBoundary(0)`); no chat model-request lock (agent session self-locks, `repo-agent-sessions.ts:291`); result persists as `assistant_answer`, not a new kind.
- Type-consistency: `ChatRepoAgentRunBinding` / `ChatRepoAgentDecisionRecord` defined in T4 step 3, consumed in T4 step 4 and T5 step 3; `ChatStreamApprovalSchema` defined in T1, consumed in T4 step 4 and T6; `appendChatRepoAgentMessages(runtimeRoot, sessionId, input)` signature consistent between T4 steps 4-5.
- Open implementation details deliberately resolved at execution time (with instructions where): required base fields of `ChatMessageBaseSchema` (T1 step 1), internal save helper used by `appendChatMessagesWithUsage` (T4 step 5), runtime-store transition idiom (T6), preset-family membership (T7 step 0).
