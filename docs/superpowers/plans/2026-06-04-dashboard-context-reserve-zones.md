# Dashboard Context Reserve Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render provider-overhead reserve on the left side of the dashboard context bar and output-headroom reserve on the right side, both as dashed sections with explanatory popups.

**Architecture:** Compute reserve token counts on the status server and serialize them through `ContextUsage`. Keep React responsible only for rendering typed visual sections from server-provided counts. Preserve the existing used-context fill behavior, including live prompt-token growth while a repo-search/plan turn is generating.

**Tech Stack:** TypeScript, Node test runner, React 19, server-rendered dashboard component tests, SiftKit status-server chat API.

---

## File Structure

- Modify `src/status-server/chat.ts`
  - Replace the current direct `buildContextUsage(session)` calculation with a small explicit `ContextUsageBuilder` class in the same file.
  - Add server-side reserve fields to the returned `Dict`: `providerOverheadTokens`, `outputHeadroomTokens`.
  - Change `buildContextUsage` to accept `(config: Dict | null | undefined, session: ChatSession)` so output headroom can use the same dynamic output-token cap inputs as chat generation.
- Modify `src/status-server/routes/chat.ts`
  - Update `buildChatSessionResponse(config, session)` to call `buildContextUsage(config, session)`.
- Modify `dashboard/src/types.ts` and `dashboard/src/types.d.ts`
  - Add typed reserve fields to `ContextUsage`.
- Modify `dashboard/src/lib/contextBar.ts`
  - Extend context-bar visual output from one fill segment to explicit ordered sections.
  - Keep `computeContextBarVisual` for existing used-fill color behavior.
- Modify `dashboard/src/tabs/ChatTab.tsx`
  - Render provider-overhead, used-context, free-context, and output-headroom sections.
  - Add accessible reserve popups through markup and CSS, not native-only `title`.
- Modify `dashboard/src/styles.css`
  - Add dashed section styles and tooltip/popover styles.
- Modify `dashboard/tests/lib/contextBar.test.ts`
  - Add unit coverage for reserve sections, clamping, and live prompt-token behavior.
- Modify `dashboard/tests/tab-components.test.tsx`
  - Add server-rendered markup coverage for dashed reserve zones and popup copy.
- Add or modify server test file discovered during implementation, preferably an existing chat/status-server unit test if one covers `buildContextUsage`.
  - If no focused test exists, add `tests/status-server-chat-context-usage.test.ts`.

---

## Task 1: Server ContextUsage Reserve Fields

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/status-server-chat-context-usage.test.ts` or the existing focused chat/status-server test file if one already imports `buildContextUsage`

- [ ] **Step 1: Search existing server tests before adding a new file**

Run:

```powershell
siftkit repo-search --prompt "Find existing tests that import buildContextUsage, buildChatSessionResponse, or status-server chat session responses. Return exact test file paths and test names."
```

Expected:

```text
Use an existing focused test file if one exists. Otherwise create tests/status-server-chat-context-usage.test.ts.
```

- [ ] **Step 2: Write failing server tests for reserve serialization**

Add this test content to the selected server test file. If creating `tests/status-server-chat-context-usage.test.ts`, use this complete file:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextUsage } from '../src/status-server/chat';
import type { ChatSession } from '../src/state/chat-sessions';
import type { Dict } from '../src/lib/types';

const SESSION: ChatSession = {
  id: 'session-1',
  title: 'Session',
  model: 'test-model',
  contextWindowTokens: 10000,
  thinkingEnabled: true,
  presetId: 'chat',
  mode: 'chat',
  condensedSummary: '',
  createdAtUtc: '2026-06-04T12:00:00.000Z',
  updatedAtUtc: '2026-06-04T12:00:00.000Z',
  messages: [{
    id: 'message-1',
    role: 'user',
    kind: 'user_text',
    content: 'Use the repository evidence.',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    associatedToolTokens: 0,
    thinkingContent: '',
    createdAtUtc: '2026-06-04T12:00:00.000Z',
    sourceRunId: null,
  }],
};

const CONFIG: Dict = {
  Runtime: {
    Model: 'test-model',
    LlamaCpp: {
      NumCtx: 10000,
      Reasoning: 'on',
      ReasoningContent: true,
      PreserveThinking: true,
    },
  },
  Server: {
    LlamaCpp: {
      ReasoningContent: true,
      PreserveThinking: true,
    },
  },
};

test('buildContextUsage serializes provider overhead and output headroom reserves', () => {
  const usage = buildContextUsage(CONFIG, SESSION);

  assert.equal(usage.contextWindowTokens, 10000);
  assert.equal(typeof usage.providerOverheadTokens, 'number');
  assert.equal(typeof usage.outputHeadroomTokens, 'number');
  assert.equal(Number.isInteger(usage.providerOverheadTokens), true);
  assert.equal(Number.isInteger(usage.outputHeadroomTokens), true);
  assert.equal(usage.providerOverheadTokens >= 0, true);
  assert.equal(usage.outputHeadroomTokens > 0, true);
  assert.equal(usage.outputHeadroomTokens <= 25000, true);
});

test('buildContextUsage clamps output headroom to remaining context', () => {
  const crowdedSession = {
    ...SESSION,
    contextWindowTokens: 100,
    messages: [{
      ...SESSION.messages[0],
      content: 'x'.repeat(1000),
    }],
  };

  const usage = buildContextUsage(CONFIG, crowdedSession);

  assert.equal(usage.remainingTokens >= 0, true);
  assert.equal(usage.outputHeadroomTokens <= usage.remainingTokens, true);
});
```

- [ ] **Step 3: Run the server test and verify it fails**

Run:

```powershell
npm test -- status-server-chat-context-usage
```

Expected:

```text
FAIL
buildContextUsage expects 1 arguments, but got 2
```

If the selected test file has a different name, run that exact test filter.

- [ ] **Step 4: Implement `ContextUsageBuilder` in `src/status-server/chat.ts`**

Replace the current `export function buildContextUsage(session: ChatSession): Dict` with this structure. Preserve the existing helper functions above it.

```ts
type ContextUsageTokenTotals = {
  contextWindowTokens: number;
  chatUsedTokens: number;
  thinkingUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
};

class ContextUsageBuilder {
  constructor(
    private readonly config: Dict | null | undefined,
    private readonly session: ChatSession,
  ) {}

  build(): Dict {
    const totals = this.buildTokenTotals();
    const warnThresholdTokens = Math.max(5000, Math.ceil(totals.contextWindowTokens * 0.1));
    return {
      contextWindowTokens: totals.contextWindowTokens,
      usedTokens: totals.chatUsedTokens,
      chatUsedTokens: totals.chatUsedTokens,
      thinkingUsedTokens: totals.thinkingUsedTokens,
      toolUsedTokens: totals.toolUsedTokens,
      totalUsedTokens: totals.totalUsedTokens,
      remainingTokens: totals.remainingTokens,
      warnThresholdTokens,
      shouldCondense: totals.remainingTokens <= warnThresholdTokens,
      estimatedTokenFallbackTokens: 0,
      providerOverheadTokens: this.getProviderOverheadTokens(),
      outputHeadroomTokens: this.getOutputHeadroomTokens(totals),
    };
  }

  private buildTokenTotals(): ContextUsageTokenTotals {
    const contextWindowTokens = Math.max(1, Number(this.session.contextWindowTokens || 150000));
    const messages = Array.isArray(this.session.messages) ? this.session.messages : [];
    const messageTokens = messages.reduce((sum: number, message: Dict) => sum + getMessageContextTokenEstimate(message), 0);
    const thinkingUsedTokens = messages.reduce((sum: number, message: Dict) => sum + getMessageThinkingTokenEstimate(message), 0);
    const chatUsedTokens = estimateTokenCount(DEFAULT_CHAT_SYSTEM_PROMPT) + messageTokens;
    const hiddenToolContexts = Array.isArray(this.session.hiddenToolContexts) ? this.session.hiddenToolContexts : [];
    const toolUsedTokens = hiddenToolContexts.length > 0
      ? estimateTokenCount(HIDDEN_TOOL_CONTEXT_PROMPT)
        + hiddenToolContexts.reduce((sum: number, entry: Dict) => sum + getHiddenToolContextTokenEstimate(entry), 0)
      : 0;
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    return {
      contextWindowTokens,
      chatUsedTokens,
      thinkingUsedTokens,
      toolUsedTokens,
      totalUsedTokens,
      remainingTokens: Math.max(contextWindowTokens - totalUsedTokens, 0),
    };
  }

  private getProviderOverheadTokens(): number {
    const thinkingEnabled = this.session.thinkingEnabled !== false;
    const reserveShape: Dict = {
      model: resolveActiveChatModel(this.config, this.session),
      stream: false,
      cache_prompt: true,
      max_tokens: 0,
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
      ],
      chat_template_kwargs: {
        enable_thinking: thinkingEnabled,
        ...(thinkingEnabled && shouldReplayReasoningContent(this.config || {}) ? { reasoning_content: true } : {}),
        ...(shouldPreserveThinking(this.config || {}, thinkingEnabled) ? { preserve_thinking: true } : {}),
      },
    };
    return estimateTokenCount(JSON.stringify(reserveShape));
  }

  private getOutputHeadroomTokens(totals: ContextUsageTokenTotals): number {
    if (totals.remainingTokens <= 0) {
      return 0;
    }
    const dynamicMaxTokens = getDynamicMaxOutputTokens({
      totalContextTokens: totals.contextWindowTokens,
      promptTokenCount: totals.totalUsedTokens,
    });
    return Math.min(dynamicMaxTokens, totals.remainingTokens);
  }
}

export function buildContextUsage(config: Dict | null | undefined, session: ChatSession): Dict {
  return new ContextUsageBuilder(config, session).build();
}
```

- [ ] **Step 5: Update the chat-session response call**

In `src/status-server/routes/chat.ts`, change:

```ts
contextUsage: buildContextUsage(session),
```

to:

```ts
contextUsage: buildContextUsage(config, session),
```

- [ ] **Step 6: Run the server test and verify it passes**

Run:

```powershell
npm test -- status-server-chat-context-usage
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit server reserve serialization**

Run:

```powershell
git add src/status-server/chat.ts src/status-server/routes/chat.ts tests/status-server-chat-context-usage.test.ts
git commit -m "feat: expose context reserve usage"
```

If using an existing test file instead of `tests/status-server-chat-context-usage.test.ts`, add that file path instead.

---

## Task 2: Dashboard Types and Context-Bar Visual Model

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/types.d.ts`
- Modify: `dashboard/src/lib/contextBar.ts`
- Test: `dashboard/tests/lib/contextBar.test.ts`

- [ ] **Step 1: Write failing context-bar visual tests**

In `dashboard/tests/lib/contextBar.test.ts`, add reserve fields to `USAGE`:

```ts
  providerOverheadTokens: 5,
  outputHeadroomTokens: 10,
```

Then append these tests:

```ts
test('resolveContextBarVisual returns ordered reserve and usage sections', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    contextWindowTokens: 100,
    chatUsedTokens: 20,
    totalUsedTokens: 20,
    remainingTokens: 80,
    providerOverheadTokens: 5,
    outputHeadroomTokens: 10,
  }, 999, null, false);

  assert.deepEqual(result?.sections.map((section) => section.kind), [
    'provider-overhead',
    'used',
    'free',
    'output-headroom',
  ]);
  assert.equal(result?.sections[0]?.percent, 5);
  assert.equal(result?.sections[1]?.percent, 20);
  assert.equal(result?.sections[3]?.percent, 10);
});

test('resolveContextBarVisual clamps reserves and used sections to the context window', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    contextWindowTokens: 100,
    chatUsedTokens: 90,
    totalUsedTokens: 90,
    remainingTokens: 10,
    providerOverheadTokens: 20,
    outputHeadroomTokens: 30,
  }, 999, null, false);

  const totalPercent = result?.sections.reduce((sum, section) => sum + section.percent, 0);
  assert.equal(totalPercent, 100);
  assert.equal(result?.sections.find((section) => section.kind === 'free'), undefined);
});

test('resolveContextBarVisual omits zero-token reserve sections', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    providerOverheadTokens: 0,
    outputHeadroomTokens: 0,
  }, 999, null, false);

  assert.deepEqual(result?.sections.map((section) => section.kind), ['used', 'free']);
});
```

- [ ] **Step 2: Run context-bar tests and verify they fail**

Run:

```powershell
npm test -- contextBar
```

Expected:

```text
FAIL
Property 'sections' does not exist on type 'ContextBarVisual'
```

- [ ] **Step 3: Extend dashboard `ContextUsage` types**

In both `dashboard/src/types.ts` and `dashboard/src/types.d.ts`, add:

```ts
  providerOverheadTokens: number;
  outputHeadroomTokens: number;
```

to the `ContextUsage` type/interface.

- [ ] **Step 4: Replace `ContextBarVisual` with section-aware types**

In `dashboard/src/lib/contextBar.ts`, replace the visual type with:

```ts
export type ContextBarSectionKind = 'provider-overhead' | 'used' | 'free' | 'output-headroom';

export type ContextBarSection = {
  kind: ContextBarSectionKind;
  tokenCount: number;
  percent: number;
  titleText: string;
};

export type ContextBarVisual = {
  ratio: number;
  percent: number;
  fillColor: string;
  titleText: string;
  sections: ContextBarSection[];
};
```

- [ ] **Step 5: Add explicit section builders**

In `dashboard/src/lib/contextBar.ts`, add these helpers below `computeContextBarVisual`:

```ts
function getNonNegativeInteger(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.trunc(numberValue) : 0;
}

function getSectionPercent(tokenCount: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (tokenCount / total) * 100)) : 0;
}

function appendSection(sections: ContextBarSection[], kind: ContextBarSectionKind, tokenCount: number, total: number, titleText: string): void {
  if (tokenCount <= 0) {
    return;
  }
  sections.push({
    kind,
    tokenCount,
    percent: getSectionPercent(tokenCount, total),
    titleText,
  });
}
```

- [ ] **Step 6: Update `resolveContextBarVisual` to produce sections**

In `dashboard/src/lib/contextBar.ts`, keep existing live-used selection. After computing `visual`, build sections like this:

```ts
  const visual = computeContextBarVisual(used, total);
  const providerOverheadTokens = getNonNegativeInteger(usage?.providerOverheadTokens);
  const outputHeadroomTokens = getNonNegativeInteger(usage?.outputHeadroomTokens);
  const providerTokens = Math.min(providerOverheadTokens, total);
  const outputTokens = Math.min(outputHeadroomTokens, Math.max(total - providerTokens, 0));
  const usedTokens = Math.min(used, Math.max(total - providerTokens - outputTokens, 0));
  const freeTokens = Math.max(total - providerTokens - usedTokens - outputTokens, 0);
  const sections: ContextBarSection[] = [];
  appendSection(
    sections,
    'provider-overhead',
    providerTokens,
    total,
    `Provider overhead reserve: ${formatNumber(providerOverheadTokens)} tokens used by request framing, model options, and chat template metadata.`,
  );
  appendSection(
    sections,
    'used',
    usedTokens,
    total,
    visual.titleText,
  );
  appendSection(
    sections,
    'free',
    freeTokens,
    total,
    `${formatNumber(freeTokens)} tokens currently free.`,
  );
  appendSection(
    sections,
    'output-headroom',
    outputTokens,
    total,
    `Output headroom reserve: ${formatNumber(outputHeadroomTokens)} tokens kept available for the assistant response.`,
  );
  return { ...visual, sections };
```

- [ ] **Step 7: Run context-bar tests and verify they pass**

Run:

```powershell
npm test -- contextBar
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit dashboard visual model**

Run:

```powershell
git add dashboard/src/types.ts dashboard/src/types.d.ts dashboard/src/lib/contextBar.ts dashboard/tests/lib/contextBar.test.ts
git commit -m "feat: model context reserve bar sections"
```

---

## Task 3: React Rendering and Tooltip Popups

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/styles.css`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing component tests**

In `dashboard/tests/tab-components.test.tsx`, add reserve fields to `CONTEXT_USAGE`:

```ts
  providerOverheadTokens: 5,
  outputHeadroomTokens: 10,
```

Append this test near the existing context-bar tests:

```ts
test('chat tab context bar renders dashed provider overhead and output headroom sections with popups', () => {
  const markup = renderChatTab({
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    contextUsage: {
      ...CONTEXT_USAGE,
      contextWindowTokens: 10000,
      chatUsedTokens: 2500,
      totalUsedTokens: 2500,
      remainingTokens: 7500,
      providerOverheadTokens: 500,
      outputHeadroomTokens: 2000,
    },
  });

  assert.match(markup, /context-bar-section provider-overhead/u);
  assert.match(markup, /context-bar-section output-headroom/u);
  assert.match(markup, /Provider overhead reserve/u);
  assert.match(markup, /request framing, model options, and chat template metadata/u);
  assert.match(markup, /Output headroom reserve/u);
  assert.match(markup, /assistant response/u);
  assert.match(markup, /width:5%/u);
  assert.match(markup, /width:20%/u);
});
```

- [ ] **Step 2: Run component tests and verify they fail**

Run:

```powershell
npm test -- tab-components
```

Expected:

```text
FAIL
The markup does not contain context-bar-section provider-overhead
```

- [ ] **Step 3: Update `ContextBar` rendering**

In `dashboard/src/tabs/ChatTab.tsx`, replace the current single fill `<div>` with:

```tsx
    <div className="context-bar" title={visual.titleText} aria-label={visual.titleText}>
      {visual.sections.map((section) => (
        <div
          key={section.kind}
          className={`context-bar-section ${section.kind}`}
          style={{ width: `${section.percent}%`, background: section.kind === 'used' ? visual.fillColor : undefined }}
          tabIndex={section.kind === 'provider-overhead' || section.kind === 'output-headroom' ? 0 : -1}
          aria-label={section.titleText}
        >
          {section.kind === 'provider-overhead' || section.kind === 'output-headroom' ? (
            <span className="context-bar-tooltip" role="tooltip">{section.titleText}</span>
          ) : null}
        </div>
      ))}
    </div>
```

- [ ] **Step 4: Add reserve-zone styles**

In `dashboard/src/styles.css`, replace the existing `.context-bar-fill` dependency with section styles:

```css
.context-bar {
  position: relative;
  display: flex;
  width: 100%;
  height: 8px;
  overflow: visible;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.16);
}

.context-bar-section {
  position: relative;
  height: 100%;
  min-width: 0;
}

.context-bar-section:first-child {
  border-radius: 999px 0 0 999px;
}

.context-bar-section:last-child {
  border-radius: 0 999px 999px 0;
}

.context-bar-section.used {
  transition: width 0.2s ease, background 0.2s ease;
}

.context-bar-section.free {
  background: rgba(148, 163, 184, 0.12);
}

.context-bar-section.provider-overhead {
  background:
    repeating-linear-gradient(
      90deg,
      rgba(148, 163, 184, 0.72) 0,
      rgba(148, 163, 184, 0.72) 4px,
      rgba(148, 163, 184, 0.2) 4px,
      rgba(148, 163, 184, 0.2) 8px
    );
}

.context-bar-section.output-headroom {
  background:
    repeating-linear-gradient(
      90deg,
      rgba(245, 158, 11, 0.78) 0,
      rgba(245, 158, 11, 0.78) 4px,
      rgba(245, 158, 11, 0.24) 4px,
      rgba(245, 158, 11, 0.24) 8px
    );
}

.context-bar-tooltip {
  position: absolute;
  z-index: 20;
  bottom: 14px;
  left: 50%;
  width: max-content;
  max-width: min(320px, 80vw);
  transform: translateX(-50%);
  padding: 8px 10px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  line-height: 1.35;
  opacity: 0;
  pointer-events: none;
  white-space: normal;
  transition: opacity 0.12s ease;
}

.context-bar-section:hover .context-bar-tooltip,
.context-bar-section:focus .context-bar-tooltip,
.context-bar-section:focus-visible .context-bar-tooltip {
  opacity: 1;
}
```

If the existing `.context-bar` block contains duplicate properties, merge rather than duplicate it.

- [ ] **Step 5: Run component tests and verify they pass**

Run:

```powershell
npm test -- tab-components
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit rendering and CSS**

Run:

```powershell
git add dashboard/src/tabs/ChatTab.tsx dashboard/src/styles.css dashboard/tests/tab-components.test.tsx
git commit -m "feat: render context reserve zones"
```

---

## Task 4: Full Validation and Coverage Check

**Files:**
- No implementation files expected unless validation finds failures.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm test -- contextBar
npm test -- tab-components
npm test -- status-server-chat-context-usage
```

Expected:

```text
PASS
PASS
PASS
```

- [ ] **Step 2: Run typecheck/build validation**

Run:

```powershell
npm run typecheck
npm run build
```

Expected:

```text
No TypeScript errors.
Build completes successfully.
```

If `npm run typecheck` is not defined in this repo version, use:

```powershell
npm run build:test
```

Expected:

```text
TypeScript compilation succeeds.
```

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected:

```text
PASS
```

- [ ] **Step 4: Use SiftKit to interpret any long validation output**

If any validation output is long, run:

```powershell
npm test 2>&1 | siftkit summary --question "Extract the failing test names, exact error messages, and the smallest likely code area responsible. Return file:line anchors where present."
```

Expected:

```text
Use only if full output is too long to inspect directly.
```

- [ ] **Step 5: Final commit if validation fixes were needed**

Run only if Step 1-3 required follow-up edits:

```powershell
git add dashboard/src src/status-server tests dashboard/tests
git commit -m "test: validate context reserve zones"
```

---

## Acceptance Criteria

- The context bar visibly contains a gray dashed provider-overhead segment at the far left when `providerOverheadTokens > 0`.
- The context bar visibly contains a muted amber dashed output-headroom segment at the far right when `outputHeadroomTokens > 0`.
- The used-context fill remains color-ramped green to red and still grows from live prompt tokens during active repo-search/plan generation.
- Hovering or focusing either dashed reserve segment shows a popup explaining what the reserve means and displaying the formatted token count.
- Reserve rendering is driven by server-provided `ContextUsage` fields, not ad hoc client estimates.
- Zero-token reserves produce no dashed segment.
- Overfull or nearly full contexts clamp visual section widths to the bar instead of overflowing.
- `npm test`, `npm run build`, and the focused context-bar/component/server tests pass.

---

## Assumptions and Defaults

- Provider overhead means request/framing overhead: model/options, chat template flags, and empty message-role structure used to estimate non-content provider prompt cost.
- Output headroom means response-generation room from `getDynamicMaxOutputTokens`, clamped to the remaining context window.
- The dashboard does not need a browser verification pass for this request because the user explicitly said no browser.
- No worktrees.
- No legacy compatibility overload for old `buildContextUsage(session)` callers; update callers directly.
- Keep all additions TypeScript-typed and avoid `any`.
- Discovery/search used `siftkit repo-search` first with extraction-oriented prompts. Raw `Get-Content` reads were narrow follow-up on known files for exact plan details.
