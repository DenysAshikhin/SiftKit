# Chat-Reachable Repo-Agent + Native In-Chat Approvals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per repo policy, dispatch `siftkit repo-agent` with 1-3 tasks at a time.

**Goal:** Start a repo-agent run from the chat composer, surface approval requests as inline chat bubbles with Approve / Deny / Abort, and persist the run result + approval audit rows into the session transcript.

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

### Task 2: Pin the context-inheritance contract (Phase A regression tests)

**Files:**
- Modify: `tests/chat-repo-operation-runner.test.ts` (engine-request stub already records requests at `:42-91`)
- Modify: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Add assertions to the existing runner test** — for both `runPlan` and `runRepoSearch`, assert the recorded `executeRepoSearch` request has NO `history` and NO `systemPrompt` keys:

```ts
assert.equal('history' in recordedRequest, false);
assert.equal('systemPrompt' in recordedRequest, false);
```

- [ ] **Step 2: Add an engine-gate test** in `tests/repo-search-chat-execute.test.ts`: build a request with `taskKind: 'repo-search'` AND a supplied `history`, assert the model call receives `historyMessages: undefined` (the guard at `src/repo-search/execute.ts:408`). Copy the setup pattern of the nearest existing test in that file.
- [ ] **Step 3: Run both files — expect PASS immediately** (these pin existing behavior): `node --test tests/chat-repo-operation-runner.test.ts tests/repo-search-chat-execute.test.ts`. If either FAILS, stop — the contract assumption is wrong; report instead of "fixing" the test.

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
  3. The engine request recorded by the mock has `taskKind: 'repo-agent'`, `prompt` = draft, and NO `history` key (pins the fresh-run contract for the new path).
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
    const started = startRepoAgentRun(ctx, {
      prompt: request.value.content,
      repoRoot: request.value.repoRoot,
      approvalMode: request.value.approval,
      images: request.value.images,
      maxTurns: request.value.maxTurns,
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
    case 'aborted': return 'Repo-agent run aborted by user.';
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
- [ ] **Step 1: Failing UI test:** with a repo-agent-family session selected, the send button reads `Run Agent`; when the runtime has a `pendingApproval`, the transcript shows a card with the command text and Approve / Deny / Abort buttons; Deny requires a non-empty reason before submit is enabled.
- [ ] **Step 2: Implement:**
  - `getSendLabel`: add `if (chatMode === 'repo-agent') { return 'Run Agent'; }`.
  - `dispatchSend`: add `if (chatMode === 'repo-agent') { void onSendRepoAgent(); return; }`.
  - `useChatController.ts:45`: `const isRepoToolMode = chatMode === 'plan' || chatMode === 'repo-search' || chatMode === 'repo-agent';` (shows the repo-root row for agent sessions too).
  - `RepoAgentApprovalCard`: props `{ approval: ChatStreamApproval; onDecide(decision): void }`; render per the mockup (header `Approval required — {toolName}`, command block, reviewPayload line when non-null, Approve `.send`-styled, Deny opens a reason textarea using the `.err-banner` palette, Abort ghost). Persisted `repo_agent_approval` messages render as resolved (read-only) cards using `approvalDecision`/`approvalReason`.
  - `chat.css`: add `.approval-card` rules; use existing tokens (`--run` amber border for pending, `--ok` for approved, `--bad`/`#8d4b53` for denied); copy exact values from the mockup's stylesheet.
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

### Task 9: Docs — context-inheritance matrix

**Files:**
- Create: `docs/context-inheritance.md`

- [ ] **Step 1: Write the matrix:** chat = full session replay (`buildChatHistoryMessages`, `src/status-server/chat.ts:310-368`); plan/repo-search = fresh run, operational state only (guard `src/repo-search/execute.ts:408`); repo-agent standalone = zero session context; repo-agent chat-launched = fresh run (draft/images/repoRoot only), result + approval rows persisted one-way into the transcript. Cite the pinning tests from Tasks 2 and 4.

---

### Task 10: Full validation

- [ ] `npm run typecheck` and `npm run lint` — expect clean.
- [ ] Broad suite through siftkit (repo policy): `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."`
- [ ] Manual smoke against a dev server: create a repo-agent-preset session → Run Agent → approve one gate, deny another with a reason → run completes → transcript shows user prompt, two approval rows, result → send a normal chat message and confirm the model's reply references the agent's work → reload mid-run at a parked approval and confirm the card reappears and Approve still works.
- [ ] Delete `.scratch/` artifacts once the mockup has served its purpose (repo policy: temporary artifacts removed at completion).

---

## Self-review notes

- Spec coverage: chat-reachable start (T4), native approvals (T5, T7), persistence + replay (T4 steps 5-6, T5 tests), fresh-run contract pinned (T2, T4 test 3), busy/409 semantics (T1, T4 test 4), reload recovery (T5 step 4, T8), standalone unchanged (T3 + rerun of standalone tests), docs (T9).
- Known deviations from the original plan draft, all evidence-backed: no `sessionId` in run schemas (in-memory binding instead); no `streamSessionBoundary` reuse in chat (interactive-mode single stream via `attach` + `waitForBoundary(0)`); no chat model-request lock (agent session self-locks, `repo-agent-sessions.ts:291`); result persists as `assistant_answer`, not a new kind.
- Type-consistency: `ChatRepoAgentRunBinding` / `ChatRepoAgentDecisionRecord` defined in T4 step 3, consumed in T4 step 4 and T5 step 3; `ChatStreamApprovalSchema` defined in T1, consumed in T4 step 4 and T6; `appendChatRepoAgentMessages(runtimeRoot, sessionId, input)` signature consistent between T4 steps 4-5.
- Open implementation details deliberately resolved at execution time (with instructions where): required base fields of `ChatMessageBaseSchema` (T1 step 1), internal save helper used by `appendChatMessagesWithUsage` (T4 step 5), runtime-store transition idiom (T6), preset-family membership (T7 step 0).
