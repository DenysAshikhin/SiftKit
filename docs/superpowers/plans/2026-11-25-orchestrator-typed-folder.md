# Orchestrator Typed Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator runs in the folder typed in the composer, as every other mode does.

**Architecture:** `ChatTab` resolves the folder once with the existing `resolveRepoRoot`: the typed folder, else the session's saved one. The start button and the start request both use it.

**Tech Stack:** TypeScript, React, vitest.

---

### Task 1: Start the orchestrator in the typed folder

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx` (lines 41, 258, 275-278, 337, 342)
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `'orchestrator mode starts a run for the saved repository and shows its live panel'`: rename it to `'orchestrator mode starts a run in the typed folder and shows its live panel'`, add this to its `orchestratorProps` call, and expect `repoRoot: 'C:/typed'` in its request:

```tsx
      runtimeHub: new ChatRuntimeHub(buildDefaultStore(ORCHESTRATOR_SESSION.id)
        .apply({ kind: 'plan-inputs', sessionId: ORCHESTRATOR_SESSION.id, planRepoRootInput: ' C:/typed ', planMaxTurnsInput: '' })),
```

After the existing test `'orchestrator mode cannot start without a saved repository folder'`, renamed to `'orchestrator mode cannot start without a folder'`, add:

```tsx
test('orchestrator mode starts in the saved folder when none is typed', async () => {
  const bodies: Array<[string, string]> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    bodies.push([String(input), typeof init?.body === 'string' ? init.body : '']);
    return new Response(JSON.stringify({ error: 'stop here' }), { status: 500 });
  };
  try {
    renderComponent(<ChatTab {...orchestratorProps({ selectedSession: { ...ORCHESTRATOR_SESSION, orchestratorRunId: null },
      runtimeHub: new ChatRuntimeHub(buildDefaultStore(ORCHESTRATOR_SESSION.id)
        .apply({ kind: 'plan-inputs', sessionId: ORCHESTRATOR_SESSION.id, planRepoRootInput: ' ', planMaxTurnsInput: '' })) })} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run orchestrator' })); });
    const start = bodies.find(([url]) => url === '/orchestrator');
    assert.equal(JSON.parse(start?.[1] ?? '{}').repoRoot, 'C:/repo');
  } finally { globalThis.fetch = originalFetch; }
});
```

In the renamed `'orchestrator mode cannot start without a folder'`, after its assertion, unmount nothing; instead add a separate test:

```tsx
test('orchestrator mode can start with only a typed folder', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`Unexpected fetch ${String(input)}`); };
  try {
    renderComponent(<ChatTab {...orchestratorProps({
      selectedSession: { ...ORCHESTRATOR_SESSION, orchestratorRunId: null, planRepoRoot: '' },
      runtimeHub: new ChatRuntimeHub(buildDefaultStore(ORCHESTRATOR_SESSION.id)
        .apply({ kind: 'plan-inputs', sessionId: ORCHESTRATOR_SESSION.id, planRepoRootInput: 'C:/typed', planMaxTurnsInput: '' })) })} />);
    assert.equal(screen.getByRole('button', { name: 'Run orchestrator' }).hasAttribute('disabled'), false);
  } finally { globalThis.fetch = originalFetch; }
});
```

If the default store carries no draft for `ORCHESTRATOR_SESSION`, set one the way the fixture's default store does, so only the folder decides whether the button is enabled.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config ./dashboard/vitest.config.ts dashboard/tests/chat-tab.test.tsx`
Expected: FAIL: the request has `C:/repo`, and the button is disabled with only a typed folder.

- [ ] **Step 3: Implement** in `dashboard/src/tabs/ChatTab.tsx`

```tsx
import { PlanMaxTurnsOverrideSchema, resolveRepoRoot } from '../lib/chat-composer-inputs.ts';
```

```tsx
  const repoRoot = resolveRepoRoot(planRepoRootInput, selectedSession?.planRepoRoot.trim() ?? '');
```

replaces the `savedRepoRoot` line. Replace every other `savedRepoRoot` with `repoRoot` (the request field becomes the shorthand `repoRoot,`), and the comment above `sendBlocked` with `// The orchestrator needs a folder and accepts a task, a plan path, or both.` No `savedRepoRoot` may remain.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --config ./dashboard/vitest.config.ts`, `npm run typecheck`
Expected: PASS. Do not commit.
