# Orchestrator Run e85529c8 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the harness bugs and avoidable time sinks found in orchestrator run e85529c8 (`docs/analysis/2026-11-23-orchestrator-418bpw-run-e85529c8.md`).

**Architecture:** Each task is an independent fix behind an existing seam:
- the compactor;
- the RAM disk cache;
- the run-log writer;
- the tool-action processor's pre-execution checks;
- the approval policy and its payload;
- the orchestrator prompts and report;
- plan validation;
- the task contract;
- the prompt-cache watch.

There are no new subsystems. Order matters in one place only: Task 5 depends on Task 4.

**Tech Stack:** TypeScript on Node (type stripping), `node:test`, zod 4, SQLite (better-sqlite3), PowerShell for commands.

**Rules for every task:**
- No `any`, no type assertions, no non-null `!`, and no namespace imports.
- Validate every IO boundary with zod.
- Comments are 1–2 lines.
- TDD: write the failing test first.
- Replace code completely, with no shims.
- **Do not commit.** The user commits.
- Run a single test file with `node .\src\test-runner\run-tests.ts <test file>`.
- Every task ends with `npm run typecheck`, which also runs lint.

**Out of scope on purpose:** these were excluded by the user.
- Worker thinking cap.
- Targeted-read guidance.
- Approving actions by rule, without a model call.
- Planning notes in `plan.md`.
- Forcing a review before the next dispatch.

---

## Task 1: Compaction always fits

**What happened in run e85529c8:** a 23-minute worker attempt was lost.
1. A turn with 20k thinking tokens left the history 4.3k short of the window.
2. The summary was sized to exactly the remaining space.
3. The engine needed one more 256-token page.
4. The retry sent the identical request and failed the same way.

**Three changes:**
- **Margin:** leave room for page rounding and the draft model's lookahead.
- **Drop kept reasoning when it doesn't fit:** if the window cannot hold the full summary output share and the history has kept reasoning, summarize the history *without* reasoning. The summary needs the decisions, not the thinking.
  - The stripped request no longer shares the planner's cache prefix. It opens a new cache epoch: one cold prefill, in this rare case only.
  - It must not reuse the planner cache origin. `deriveCompactionBranch` throws when the history diverges from the executing prefix.
- **No identical retry:** never resend a request the provider rejected as too long.

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts` (one constant)
- Modify: `src/repo-search/engine/transcript-compactor.ts` (`compact`, `resolveSummaryGenerationTokens`, `requestSummary`)
- Test: `tests/engine-transcript-compactor.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these imports to `tests/engine-transcript-compactor.test.ts`, merging with the existing import lines from the same modules:

```ts
import { captureExecutingPlannerRequest, serializeProtocolMessages } from '../src/repo-search/planner-protocol.ts';
import { COMPACTION_WINDOW_MARGIN_TOKENS } from '../src/repo-search/engine/turn-budget.ts';
import { errorFrame } from './helpers/streaming-client.ts';
```

Append:

```ts
const THINKING_FLAGS = { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true };

// Real case (run e85529c8): one 20k-thinking turn left 4.3k of the window, and the summary could not fit.
test('a history whose kept reasoning overfills the window is summarized without its reasoning', async () => {
  const logged: Array<Record<string, JsonSerializable>> = [];
  const config = mockOfflineSiftConfig();
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    // 4 characters per token: 8k tokens of content and 20k tokens of kept reasoning.
    { role: 'assistant', content: 'H'.repeat(8_000 * 4), reasoning_content: 'R'.repeat(20_000 * 4) },
    { role: 'user', content: 'latest user intent' },
  ];
  const compactor = new TranscriptCompactor({
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, config, baseUrl: DEAD_BASE_URL, model: 'mock-model', timeoutMs: 5_000,
    totalContextTokens: 32_000, compactionReserveTokens: PROMPT_COMPACTION_RESERVE_TOKENS, useEstimatedTokensOnly: true,
    mockResponses: [{ content: 'SUMMARY BODY' }], tokenUsage: new TokenUsageTracker(config, true),
    logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { logged.push(event); } }, abortSignal: undefined,
  });
  // The planner's cache prefix holds the reasoning, so the stripped request must not claim that prefix.
  const executing = captureExecutingPlannerRequest(serializeProtocolMessages(messages, true), THINKING_FLAGS, PLANNER_TOOLS, 0);

  const outcome = await compactor.compact({ taskId: 't1', turn: 93, messages, mockResponseIndex: 0,
    retention: { kind: 'latest_user' }, cacheOrigin: { kind: 'planner', executing } });

  assert.equal(outcome.summaryText, 'SUMMARY BODY');
  assert.equal(outcome.summaryOutputTokenBudget, Math.floor(PROMPT_COMPACTION_RESERVE_TOKENS / 3));
  assert.equal(outcome.summaryGenerationTokenBudget, PROMPT_COMPACTION_RESERVE_TOKENS);
  assert.deepEqual(logged.filter((event) => event.kind === 'turn_compaction_reasoning_dropped').map((event) => event.turn), [93]);
});

test('the summary budget leaves a margin below the physical window', async () => {
  const totalContextTokens = 32_000;
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }], totalContextTokens);
  // 4 characters per token: leaves 3,000 tokens of the window before the margin.
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'assistant', content: 'H'.repeat((totalContextTokens - 3_000) * 4) },
    { role: 'user', content: 'latest user intent' },
  ];

  const outcome = await compactor.compact({ taskId: 't1', turn: 9, messages, mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH });

  assert.equal(outcome.summaryGenerationTokenBudget <= 3_000 - COMPACTION_WINDOW_MARGIN_TOKENS, true);
});

test('a summary request rejected as too long is not resent', async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${errorFrame({ message: 'Job requires 666 pages (only 665 available)', type: 'invalid_request_error',
        param: null, code: 'context_length_exceeded' })}\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve());
  });
  const config = mockOfflineSiftConfig();
  try {
    const compactor = new TranscriptCompactor({
      throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, config, baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
      model: 'mock-model', timeoutMs: 5_000, totalContextTokens: 32_000, compactionReserveTokens: PROMPT_COMPACTION_RESERVE_TOKENS,
      useEstimatedTokensOnly: true, mockResponses: undefined, tokenUsage: new TokenUsageTracker(config, true), logger: null, abortSignal: undefined,
    });
    await assert.rejects(
      compactor.compact({ taskId: 't1', turn: 93, messages: transcript(), mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH }),
      /planner_compaction_failed attempts=1 turn=93 last_error=Provider rejected the prompt as too long/u,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node .\src\test-runner\run-tests.ts tests\engine-transcript-compactor.test.ts`

Expected: the three new tests fail.
- The margin test: `COMPACTION_WINDOW_MARGIN_TOKENS` is not exported.
- The reasoning test: the output budget is about 2.9k, not 5,000.
- The rejection test: it sees 2 requests and `attempts=2`.

- [ ] **Step 3: Add the margin constant**

In `src/repo-search/engine/turn-budget.ts`, below `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS`:

```ts
// The engine allocates its cache in 256-token pages and the draft model looks past max_tokens; run e85529c8 fell one page short.
export const COMPACTION_WINDOW_MARGIN_TOKENS = 1_024;
```

- [ ] **Step 4: Fit the summary with a margin; drop kept reasoning when it does not fit**

In `src/repo-search/engine/transcript-compactor.ts`:

1. Add two imports, and extend the turn-budget import:

```ts
import { ProviderContextLengthError } from '../../llm-protocol/stream-errors.ts';
```
```ts
import {
  COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
  COMPACTION_WINDOW_MARGIN_TOKENS,
  splitCompactionGenerationTokens,
} from './turn-budget.ts';
```

2. Below `COMPACTION_SUMMARY_ATTEMPTS`, add:

```ts
type SummaryGenerationTokens = ReturnType<typeof splitCompactionGenerationTokens>;

/** What the window leaves a summary request; `fullOutput` is false when the output share had to shrink. */
type SummaryFit = { generationTokens: SummaryGenerationTokens; fullOutput: boolean; promptTokenCount: number; remainingTokens: number };

function hasReasoningContent(message: ChatMessage): boolean {
  return typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
}

function withoutReasoningContent(message: ChatMessage): ChatMessage {
  const { reasoning_content: _reasoningContent, ...rest } = message;
  return rest;
}

/** The planner's tools and flags without its cache prefix: a request whose history differs opens a new epoch. */
function newEpochOrigin(origin: CompactionCacheOrigin): CompactionCacheOrigin {
  const state = origin.kind === 'planner' ? origin.executing : origin;
  return { kind: 'new_epoch', flags: state.flags, tools: state.tools };
}
```

3. In `compact`, replace:

```ts
    const summaryRequestMessages: ChatMessage[] = [...historyMessages, { role: 'user', content: instruction }];
    const generationTokens = await this.resolveSummaryGenerationTokens(input, summaryRequestMessages);

    const summary = await this.requestSummary(input, historyMessages, instruction, generationTokens);
```

with:

```ts
    const instructionMessage: ChatMessage = { role: 'user', content: instruction };
    let summaryHistory = historyMessages;
    let summaryInput = input;
    let fit = await this.fitSummaryGeneration(input, [...summaryHistory, instructionMessage]);
    // Kept reasoning is what overfills the window; the summary needs the decisions, not the thinking behind them.
    if (!fit.fullOutput && summaryHistory.some(hasReasoningContent)) {
      const beforePromptTokenCount = fit.promptTokenCount;
      summaryHistory = summaryHistory.map(withoutReasoningContent);
      summaryInput = { ...input, cacheOrigin: newEpochOrigin(input.cacheOrigin) };
      fit = await this.fitSummaryGeneration(summaryInput, [...summaryHistory, instructionMessage]);
      this.options.logger?.write({ kind: 'turn_compaction_reasoning_dropped', taskId: input.taskId, turn: input.turn,
        beforePromptTokenCount, afterPromptTokenCount: fit.promptTokenCount });
    }
    const generationTokens = this.requireSummaryFit(input, fit);

    const summary = await this.requestSummary(summaryInput, summaryHistory, instruction, generationTokens);
```

4. Replace the whole `resolveSummaryGenerationTokens` method, including its doc comment, with:

```ts
  /**
   * The summary generation gets what the window leaves after its prompt and a margin, up to the run's response
   * reserve. Two thirds cap thinking; the remaining third is the floor under the summary output, not its cap.
   */
  private async fitSummaryGeneration(
    input: { cacheOrigin: CompactionCacheOrigin },
    summaryRequestMessages: ChatMessage[],
  ): Promise<SummaryFit> {
    const state = input.cacheOrigin.kind === 'planner'
      ? input.cacheOrigin.executing
      : input.cacheOrigin;
    const generationTokenCeiling = Math.max(0, Math.floor(this.options.compactionReserveTokens));
    const measurement = await countPlannerPromptTokens({
      config: this.tokenCountConfig,
      prompt: renderWirePrompt({
        messages: summaryRequestMessages,
        tools: state.tools,
        includeReasoningContent: state.flags.reasoningContentEnabled,
      }),
    });
    const promptTokenCount = measurement.promptTokenCount;
    const remainingTokens = this.options.totalContextTokens - promptTokenCount - COMPACTION_WINDOW_MARGIN_TOKENS;
    const requestedTokens = splitCompactionGenerationTokens(generationTokenCeiling);
    const outputTokens = Math.min(requestedTokens.outputTokens, Math.max(remainingTokens, 0));
    const reasoningTokens = Math.min(
      requestedTokens.reasoningTokens,
      Math.max(remainingTokens - outputTokens, 0),
    );
    return {
      generationTokens: { totalTokens: reasoningTokens + outputTokens, reasoningTokens, outputTokens },
      fullOutput: outputTokens >= requestedTokens.outputTokens,
      promptTokenCount,
      remainingTokens,
    };
  }

  /** Below COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS a summary is a stub that loses the conversation, so the run fails loudly. */
  private requireSummaryFit(input: { taskId: string; turn: number | null }, fit: SummaryFit): SummaryGenerationTokens {
    if (fit.generationTokens.outputTokens >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS) {
      return fit.generationTokens;
    }
    const message = `planner_compaction_prompt_overflow prompt_tokens=${fit.promptTokenCount} `
      + `remaining_tokens=${fit.remainingTokens} min_summary_output_tokens=${COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS} `
      + `total_context_tokens=${this.options.totalContextTokens} turn=${formatTurn(input.turn)}`;
    this.options.logger?.write({
      kind: 'turn_compaction_prompt_overflow_fail',
      taskId: input.taskId,
      turn: input.turn,
      promptTokenCount: fit.promptTokenCount,
      remainingTokens: fit.remainingTokens,
      minSummaryOutputTokens: COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
      totalContextTokens: this.options.totalContextTokens,
      error: message,
    });
    throw new Error(message);
  }
```

5. In `requestSummary`, change the parameter type `generationTokens: ReturnType<typeof splitCompactionGenerationTokens>,` to `generationTokens: SummaryGenerationTokens,`. Then replace its `catch` block:

```ts
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
```

with:

```ts
      } catch (error) {
        // A context-size rejection repeats exactly on an identical request; fail now instead of resending it.
        if (error instanceof ProviderContextLengthError) {
          throw new Error(`planner_compaction_failed attempts=${attempt} turn=${formatTurn(input.turn)} last_error=${error.message}`);
        }
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
```

- [ ] **Step 5: Run the compactor and loop tests**

Run: `node .\src\test-runner\run-tests.ts tests\engine-transcript-compactor.test.ts tests\mock-repo-search-loop.test.ts tests\live-repo-agent-compaction-replay.test.ts tests\repo-search-orchestrator-tools.test.ts`

Expected: all pass. The existing near-window tests still leave more than the 512-token minimum after the margin.

If the rejection test still sees 2 requests, a layer between the stream and `requestSummary` is wrapping the error.
- Find it with `grep -rn "ProviderContextLengthError" src`.
- Make that layer rethrow the original error.
- Do not match on the message text.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 2: The RAM disk wipes a cache only when its budget was lowered

**The bug:** `tidyFolders` wipes any preset folder whose bytes exceed its budget. But exllamav3 fills a folder right up to its own budget. In the run that was 10,736,273,654 of 10,737,418,240 bytes, so any index growth tips it over and the next swap wipes the cache.

**The fix:** SiftKit writes a marker recording the budget it gave each folder. It wipes a folder only when the configured budget is now lower than the marker.

A folder with no readable marker is wiped. That is safe: the RAM disk is discarded on shutdown and leftovers are removed, so every folder a live server finds was created by this code, with a marker.

**Files:**
- Modify: `src/status-server/ram-disk-cache.ts`
- Test: `tests/ram-disk-cache.test.ts`

- [ ] **Step 1: Write the failing test and adjust the wipe test**

In `tests/ram-disk-cache.test.ts`, import the new export:

```ts
import { BUDGET_MARKER_FILE, OWNER_FILE, RamDiskCache } from '../src/status-server/ram-disk-cache.ts';
```

Below `OwnerFileSchema`, add:

```ts
const BudgetMarkerFileSchema = z.object({ budgetBytes: z.number() });
```

Append:

```ts
// Real case (run e85529c8): exllamav3 filled the 27B folder to 1.1 MB under its budget; one more write and a swap wiped it.
test('a folder filled past its unchanged budget keeps its cache; only a lowered budget wipes it', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  const small = preset('flash-next', true, 1);
  await cache.prepare(CONFIG, [small, BIG], small);
  const root = driver.disk?.root ?? '';
  const pages = fs.openSync(path.join(root, 'flash-next', 'pages.bin'), 'w');
  fs.ftruncateSync(pages, GIB + 4096);
  fs.closeSync(pages);
  await cache.prepare(CONFIG, [small, BIG], BIG);
  await cache.prepare(CONFIG, [small, BIG], small);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'pages.bin')), 'over its own budget by overhead only: kept');
  assert.deepEqual(warnings.mock.calls, []);
  await cache.prepare(CONFIG, [preset('flash-next', true, 2), BIG], BIG);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'pages.bin')), 'a raised budget keeps the cache too');
  const marker = BudgetMarkerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'flash-next', BUDGET_MARKER_FILE), 'utf8')));
  assert.equal(marker.budgetBytes, 2 * GIB);
});
```

In the existing test `'folders of presets no longer on the RAM disk are deleted, and a folder over its lowered budget is wiped with a warning'`, change this line:

```ts
  assert.deepEqual(fs.readdirSync(path.join(root, 'flash-next')), [], 'over budget: wiped and remade empty');
```

to:

```ts
  assert.deepEqual(fs.readdirSync(path.join(root, 'flash-next')), [BUDGET_MARKER_FILE], 'lowered budget: wiped and remade with only its marker');
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\ram-disk-cache.test.ts`

Expected: the tests fail. `BUDGET_MARKER_FILE` is not exported, and the folder over its unchanged budget is wiped with a `ram_disk_folder_wiped` warning.

- [ ] **Step 3: Implement the marker**

In `src/status-server/ram-disk-cache.ts`:

1. Below `const OwnerSchema = ...`:

```ts
/** SiftKit's record of the budget it gave a preset folder; only a lower budget later wipes the folder. */
export const BUDGET_MARKER_FILE = 'siftkit-budget.json';
const BudgetMarkerSchema = z.object({ budgetBytes: z.number().int().nonnegative() });
```

2. Delete the `directoryBytes` function; nothing else uses it.

3. Below `liveOwner`:

```ts
/** The budget SiftKit last gave `folder`; a missing or corrupt marker means the folder is not one SiftKit sized. */
function markedBudget(folder: string): number | null {
  const file = path.join(folder, BUDGET_MARKER_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = BudgetMarkerSchema.safeParse(parseJsonValueText(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.budgetBytes : null;
  } catch {
    return null;
  }
}

function markBudget(folder: string, budgetBytes: number): void {
  fs.writeFileSync(path.join(folder, BUDGET_MARKER_FILE), JSON.stringify({ budgetBytes }));
}
```

4. In `prepare`, replace:

```ts
    this.tidyFolders(disk, ramDiskPresets);
    fs.mkdirSync(path.join(disk.root, preset.id), { recursive: true });
```

with:

```ts
    this.tidyFolders(disk, ramDiskPresets);
    const folder = path.join(disk.root, preset.id);
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
      markBudget(folder, preset.RamDiskCacheGiB * GIB);
    }
```

5. In `tidyFolders`, keep the `if (budget === undefined)` branch. Replace the rest of the chain (`else if (directoryBytes(folder) > budget) { … } else { clearBudgetDeclarations(folder); }`) with:

```ts
      } else {
        const marked = markedBudget(folder);
        if (marked === null || marked > budget) {
          serverLogger.warning({ scope: 'exl3', id: entry.name, event: 'ram_disk_folder_wiped', fields: '',
            alert: `RAM disk cache of preset '${entry.name}' ${marked === null ? 'had no budget marker' : 'exceeded its lowered budget'}; wiped it.` });
          fs.rmSync(folder, { recursive: true, force: true });
        } else {
          clearBudgetDeclarations(folder);
          markBudget(folder, budget);
        }
      }
```

- [ ] **Step 4: Run the RAM disk tests**

Run: `node .\src\test-runner\run-tests.ts tests\ram-disk-cache.test.ts tests\ram-disk-config.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 3: The run log keeps the model that served the run

**The bug:** `persistStatusRunLog` writes whichever preset is active when the terminal status arrives. The upsert's `COALESCE(excluded.model, run_logs.model)` lets that value overwrite the model the engine recorded. In the run:
- workers that finished as the swap back began were labelled with the orchestrator's model;
- the aborted orchestrator was labelled with the 27B.

**Files:**
- Modify: `src/status-server/status-run-log.ts`
- Test: `tests/runtime-status-server.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/runtime-status-server.test.ts`, next to `SpeculativeRowSchema`:

```ts
const ModelRowSchema = z.object({ model: z.string().nullable(), speculative_accepted_tokens: z.number().nullable() });
```

Append after `'real status server patches speculative acceptance onto an existing repo-search run log row'`:

```ts
// Real case (run e85529c8): workers finished as the swap back began and were labelled with the orchestrator's model.
test('real status server keeps the model the engine recorded instead of the preset active when the status lands', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'repo-run-served-model';

    await withRealStatusServer(async ({ statusUrl }) => {
      withRuntimeDatabaseConnection(runtimeDbPath, (database) => {
        upsertRepoSearchRun({
          database, requestId, taskKind: 'repo-search', identity: UNRECORDED_RUN_IDENTITY, prompt: 'find tool calls',
          repoRoot: tempRoot, model: 'served-model', backend: 'exl3', requestMaxTokens: 512, maxTurns: 2, transcriptText: '',
          artifactPayload: { requestId, prompt: 'find tool calls', repoRoot: tempRoot }, terminalState: 'completed',
          startedAtUtc: '2026-04-20T11:49:38.706Z', finishedAtUtc: '2026-04-20T11:50:26.779Z', requestDurationMs: 48073,
          promptTokens: 10, outputTokens: 5, thinkingTokens: 2, toolTokens: 1, promptCacheTokens: 3, promptEvalTokens: 7,
          promptEvalDurationMs: null, generationDurationMs: null, speculativeAcceptedTokens: null, speculativeGeneratedTokens: null,
        });
      });

      await postCompletedStatus(statusUrl, {
        requestId, taskKind: 'repo-search', terminalState: 'completed', promptCharacterCount: 25, inputTokens: 7,
        outputCharacterCount: 12, outputTokens: 5, thinkingTokens: 2, promptCacheTokens: 3, promptEvalTokens: 7,
        speculativeAcceptedTokens: 12, speculativeGeneratedTokens: 18, requestDurationMs: 48073,
      });

      await waitForAsyncExpectation(() => {
        const verifyDb = openStoredRuntimeDatabase(runtimeDbPath);
        try {
          const row = ModelRowSchema.parse(verifyDb.prepare(
            'SELECT model, speculative_accepted_tokens FROM run_logs WHERE request_id = ?').get(requestId));
          assert.equal(row.speculative_accepted_tokens, 12, 'the terminal status write has landed');
          assert.equal(row.model, 'served-model');
        } finally {
          verifyDb.close();
        }
      });
    }, { statusPath, configPath, terminalMetadataIdleDelayMs: 0, disableManagedEngineStartup: true });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\runtime-status-server.test.ts`

Expected: the new test fails. `row.model` is the active preset's model from the test config, not `served-model`.

- [ ] **Step 3: Keep the recorded model**

In `src/status-server/status-run-log.ts`, add `import { z } from '../lib/zod.ts';`, and above `persistStatusRunLog`:

```ts
const RecordedModelRowSchema = z.object({ model: z.string().nullable() }).optional();

/** The model the engine recorded for this run; the preset active when the status lands may already serve the next run. */
function readRecordedModel(ctx: ServerContext, runId: string): string | null {
  return RecordedModelRowSchema.parse(ctx.runtimeDatabase.prepare('SELECT model FROM run_logs WHERE run_id = ?').get(runId))?.model ?? null;
}
```

In `persistStatusRunLog`, change `model: activePreset.Model,` to:

```ts
    model: readRecordedModel(ctx, job.requestId) ?? activePreset.Model,
```

The two writers can land in either order, and both orders end correct:
- If the status lands first, the engine's later write replaces the model.
- If the engine lands first, the status keeps the engine's model.

- [ ] **Step 4: Run the run-log tests**

Run: `node .\src\test-runner\run-tests.ts tests\runtime-status-server.test.ts tests\repo-search-admissions.test.ts tests\dashboard-status-server.run-logs.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 4: `run` and `run_check` refuse commands that only read (#12, harness part)

**What happened in the run:**
- In one review, about 15 of 38 calls read code through `run_check` with `Select-String`, `Get-Content` or `git show`.
- Workers did the same through `run`: 72 shell reads in all.
- Each one is a tool round trip, usually with more context than `read`, `grep` or `git` would return. For workers, each also cost an approval reviewer call that the read tools never need.

**The fix:** refuse a `run` or `run_check` in which every command only reads, and name the tool to use instead.
- It is checked before approval, like the existing `Select-Object` guard.
- Anything that executes, writes or redirects runs as before.
- It is a separate function, not part of `findShellCommandProblem`. That function's tests assert that read commands pass its path rules, and those tests stay valid.

**Files:**
- Modify: `src/repo-search/engine/shell-command-policy.ts` (new export)
- Modify: `src/repo-search/engine/tool-action-processor.ts:429`
- Test: `tests/shell-command-policy.test.ts`, new `tests/repo-agent-exploration-limits.test.ts`

- [ ] **Step 1: Write the failing unit test**

In `tests/shell-command-policy.test.ts`:

```ts
import { findPathsOutsideRepo, findShellCommandProblem, findShellReadCommand } from '../src/repo-search/engine/shell-command-policy.ts';
```

Append:

```ts
// Real case (run e85529c8): a 38-turn review read code through run_check with Select-String, Get-Content, and git show.
test('a run or run_check that only reads is named with the tool to use; one that executes, writes, or redirects is not', () => {
  for (const [command, named] of [
    ['Get-Content src/a.ts', 'Get-Content'],
    ['Get-Content package.json | Select-String typecheck', 'Get-Content'],
    ['Select-String -Path src/*.ts -Pattern foo | Out-String', 'Select-String'],
    ['git show HEAD:src/a.ts', 'git show'],
    ['git status --porcelain; git diff --stat', 'git status'],
    ['$l = Get-Content scratch/e2e.log; $l[10..40]', 'Get-Content'],
    ['Get-Content a.txt | Where-Object { $_ -match "x" }', 'Get-Content'],
    ['Test-Path src/a.ts', 'Test-Path'],
  ]) {
    const problem = findShellReadCommand(run(command)) ?? '';
    assert.ok(problem.startsWith(`\`${named}\` only reads: use your read, grep, find, ls, or git tool instead.`), `${command}\n${problem}`);
  }
  for (const command of ['npm test', 'node scratch/probe.ts', 'Get-Content a.txt | node scratch/parse.ts', 'Get-Content a.txt > b.txt',
    'git stash list', 'git commit -m x', 'Remove-Item scratch/x.txt', '$PSVersionTable', '1..3 | ForEach-Object { $_ }']) {
    assert.equal(findShellReadCommand(run(command)), null, command);
  }
  assert.ok((findShellReadCommand({ toolName: 'run_check', args: { command: 'git grep -n foo', cwd: '.' } }) ?? '').startsWith('`git grep` only reads'));
  assert.equal(findShellReadCommand({ toolName: 'read', args: { path: 'a.ts' } }), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\shell-command-policy.test.ts`
Expected: fails, because `findShellReadCommand` is not exported.

- [ ] **Step 3: Implement `findShellReadCommand`**

In `src/repo-search/engine/shell-command-policy.ts`, below `SIFTKIT_EXECUTABLE`:

```ts
// Commands that only read or format what they read; the read, grep, find, ls, and git tools do the same work.
const READ_ONLY_COMMANDS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'findstr', 'test-path',
  'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi', 'resolve-path', 'out-string', 'select-object', 'select',
  'measure-object', 'measure', 'where-object', 'where', '?', 'sort-object', 'sort', 'format-list', 'fl', 'format-table',
  'ft', 'write-output', 'echo', 'write-host']);
const READ_ONLY_GIT = new Set(['show', 'grep', 'log', 'status', 'diff', 'blame', 'ls-files']);
const REDIRECT = /(?<![\w-])[1-6*]?>/u;
```

Below `findSiftKitInvocation`:

```ts
/**
 * A run or run_check whose every command only reads: it is refused with the tool to use instead. A variable
 * expression (`$x`, `$_`) is no command; a redirect or any other command makes the whole call real work.
 */
export function findShellReadCommand(call: RepoNativeToolCall): string | null {
  if (call.toolName !== 'run' && call.toolName !== 'run_check') return null;
  let first: string | null = null;
  for (const { tokens, bare, commandStarts } of splitStatements(call.args.command)) {
    if (REDIRECT.test(bare)) return null;
    for (const start of commandStarts) {
      const token = tokens[start] ?? '';
      if (token.startsWith('$')) continue;
      const head = token.toLowerCase();
      const subcommand = (tokens[start + 1] ?? '').toLowerCase();
      if (head === 'git' ? !READ_ONLY_GIT.has(subcommand) : !READ_ONLY_COMMANDS.has(head)) return null;
      first ??= head === 'git' ? `git ${subcommand}` : token;
    }
  }
  return first === null ? null
    : `\`${first}\` only reads: use your read, grep, find, ls, or git tool instead. run and run_check are for tests, builds, `
      + 'and commands that execute or change something.';
}
```

- [ ] **Step 4: Run the unit test**

Run: `node .\src\test-runner\run-tests.ts tests\shell-command-policy.test.ts`
Expected: all pass.

- [ ] **Step 5: Write the failing loop test**

Create `tests/repo-agent-exploration-limits.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject, JsonSerializable } from '../src/lib/json-types.ts';
import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { parseLoggedEvent } from './helpers/logged-events.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.ts';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-exploration-limits-');

function memoryLogger(events: JsonObject[]) {
  return { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } };
}

test('a worker run that only reads is refused before approval and names the read tools', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Check the readme.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['run']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 4, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    mockResponses: [{ toolCalls: [{ name: 'run', arguments: { command: 'Get-Content README.md | Select-String install' } }] },
      ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const run = events.find((event) => event.kind === 'turn_command_result' && event.toolName === 'run');
  assert.equal(run?.rejectionKind, 'safety');
  assert.match(String(run?.rejectionReason), /^`Get-Content` only reads: use your read, grep, find, ls, or git tool instead\./u);
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\repo-agent-exploration-limits.test.ts`
Expected: fails; the `run` call is not rejected.

- [ ] **Step 7: Wire the check into the processor**

In `src/repo-search/engine/tool-action-processor.ts`, change the import to:

```ts
import { findShellCommandProblem, findShellReadCommand } from './shell-command-policy.ts';
```

At line 429, replace:

```ts
    const commandProblem = findShellCommandProblem(nativeCall, this.deps.repoRoot);
```

with:

```ts
    const commandProblem = findShellCommandProblem(nativeCall, this.deps.repoRoot) ?? findShellReadCommand(nativeCall);
```

- [ ] **Step 8: Run the affected suites**

Run: `node .\src\test-runner\run-tests.ts tests\repo-agent-exploration-limits.test.ts tests\shell-command-policy.test.ts tests\mock-repo-search-loop.test.ts tests\repo-search-orchestrator-tools.test.ts tests\engine-tool-action-processor.test.ts tests\repo-search-agent-execute.test.ts`

Expected: all pass.

An existing loop test may have used a read-only `run` as a placeholder for "some command". If so:
- Switch it to a command that is not read-only, such as `node -e "console.log(1)"`.
- List each such change in the task report. These are behaviour changes, not weakened tests.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 5: Worker edit deadline (#5)

**The rule:** this mirrors the orchestrator's plan deadline. Once a worker's prompt passes 75% of its window and it has written nothing:
- `read`, `grep`, `find`, `ls` and `git` are refused;
- only `edit`, `write` and `run` are accepted, and Task 4 already refuses read-only `run`;
- reading resumes after the first successful `edit` or `write`.

**Why it lasts across compactions:** the deadline stays on until the first write, even through a compaction. Otherwise a worker that compacts with nothing written just starts re-reading. That is how `agent-endpoints` spent 93 turns and two context windows.

**Scope:** repo-agent runs that are not the orchestrator and have `edit` or `write`. Chat and repo-search are unaffected.

**Depends on:** Task 4 (the shared test file and the refusal of read-only `run`).

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts` (rename the shared deadline share)
- Modify: `src/repo-search/engine/tool-action-processor.ts` (lines 386–399 and 542–550)
- Test: `tests/repo-agent-exploration-limits.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-agent-exploration-limits.test.ts`:

```ts
const read = (file: string) => ({ toolCalls: [{ name: 'read', arguments: { path: file } }] });
// 312k characters is about 78k tokens: past the 75k deadline of a 100k window, short of its compaction point.
const LATE_HISTORY = [{ role: 'assistant' as const, content: 'H'.repeat(312_000) }];

// Real case (run e85529c8): agent-endpoints read for 93 turns and two context windows and wrote nothing.
test('a worker past three quarters of its context with nothing written may only write, then reads again', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Add notes.txt.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'write']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 6, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    totalContextTokens: 100_000, historyMessages: LATE_HISTORY,
    mockResponses: [read('README.md'), { toolCalls: [{ name: 'write', arguments: { path: 'notes.txt', content: 'notes\n' } }] },
      read('notes.txt'), ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const results = events.filter((event) => event.kind === 'turn_command_result');
  const reads = results.filter((event) => event.toolName === 'read');
  assert.equal(reads.length, 2);
  assert.equal(reads[0]?.rejectionKind, 'budget');
  assert.match(String(reads[0]?.rejectionReason),
    /^Edit deadline: the prompt is [\d,]+ of 100,000 context tokens and nothing has been written yet\./u);
  assert.equal(results.find((event) => event.toolName === 'write')?.exitCode, 0);
  assert.equal(reads[1]?.exitCode, 0, 'after the first write, reading is allowed again');
});

test('a worker without edit or write tools is never held to the edit deadline', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Read the readme.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 4, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    totalContextTokens: 100_000, historyMessages: LATE_HISTORY,
    mockResponses: [read('README.md'), ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const reads = events.filter((event) => event.kind === 'turn_command_result' && event.toolName === 'read');
  assert.doesNotMatch(String(reads[0]?.rejectionReason), /Edit deadline/u);
});
```

- [ ] **Step 2: Run them; the first fails**

Run: `node .\src\test-runner\run-tests.ts tests\repo-agent-exploration-limits.test.ts`

Expected:
- The edit-deadline test fails, because the first read is not rejected.
- The no-write-tools test already passes. It is there to guard the scope.

- [ ] **Step 3: Rename the deadline share so both deadlines use it**

In `src/repo-search/engine/turn-budget.ts`, replace:

```ts
// An orchestrator's compaction keeps only its run state, so past this share of its window with no plan
// saved it may only call save_plan; the last quarter is left for writing the plan before compaction.
const ORCHESTRATOR_PLAN_DEADLINE_SHARE = 0.75;
```

with:

```ts
// Past this share of the window, exploring stops until the run has something a compaction cannot lose: an
// orchestrator's saved plan, or a worker's first write. The last quarter is left for writing it.
const EXPLORATION_DEADLINE_SHARE = 0.75;
```

and replace the getter:

```ts
  get planDeadlineTokens(): number {
    return Math.floor(this.totalContextTokens * ORCHESTRATOR_PLAN_DEADLINE_SHARE);
  }
```

with:

```ts
  get explorationDeadlineTokens(): number {
    return Math.floor(this.totalContextTokens * EXPLORATION_DEADLINE_SHARE);
  }
```

Then update every use: `grep -rn "planDeadlineTokens" src tests`. Today only `tool-action-processor.ts:546` uses it.

- [ ] **Step 4: Add the edit deadline to the processor**

In `src/repo-search/engine/tool-action-processor.ts`:

1. With the module constants:

```ts
// Past the edit deadline a worker may only change files; run calls that only read are refused separately.
const EDIT_DEADLINE_TOOLS = new Set(['edit', 'write', 'run']);
```

2. In the class, below `private progressToolCallSeq = 0;`:

```ts
  /** Set once a worker passes the deadline with nothing written; it stays set across compactions until a write lands. */
  private editDeadlineReached = false;
```

3. Replace lines 386–387:

```ts
    const planDeadline = this.findPlanDeadline(normalizedToolName, promptTokenCount);
    if (planDeadline !== null) {
```

with:

```ts
    const deadline = this.findPlanDeadline(normalizedToolName, promptTokenCount)
      ?? this.findEditDeadline(normalizedToolName, promptTokenCount);
    if (deadline !== null) {
```

and in that block change `reason: planDeadline,` to `reason: deadline,`.

4. In `findPlanDeadline`, change `budget.planDeadlineTokens` to `budget.explorationDeadlineTokens`. Below `findPlanDeadline`, add:

```ts
  /** Why a worker past its deadline with nothing written may not run this tool: only a change is accepted until one lands. */
  private findEditDeadline(toolName: string, promptTokenCount: number): string | null {
    const { budget, mutatedPaths, orchestratorTools, runtimeProfile, allowedPlannerToolNames } = this.deps;
    const canChangeFiles = allowedPlannerToolNames.includes('edit') || allowedPlannerToolNames.includes('write');
    if (orchestratorTools !== null || runtimeProfile.loopKind !== 'repo-agent' || !canChangeFiles || mutatedPaths.size > 0) return null;
    if (promptTokenCount >= budget.explorationDeadlineTokens) this.editDeadlineReached = true;
    if (!this.editDeadlineReached || EDIT_DEADLINE_TOOLS.has(toolName)) return null;
    return `Edit deadline: the prompt is ${formatInteger(promptTokenCount)} of ${formatInteger(budget.totalContextTokens)} context tokens `
      + 'and nothing has been written yet. Reading has stopped, because a compaction would drop everything you read: '
      + 'write the failing test or make your first edit now with what you know, or finish if no change is needed. '
      + 'Reading resumes after your first successful edit or write.';
  }
```

- [ ] **Step 5: Run the tests**

Run: `node .\src\test-runner\run-tests.ts tests\repo-agent-exploration-limits.test.ts tests\repo-search-orchestrator-tools.test.ts tests\mock-repo-search-loop.test.ts tests\engine-turn-budget.test.ts tests\live-repo-agent-compaction-replay.test.ts tests\repo-search-agent-execute.test.ts`

Expected: all pass.

An existing repo-agent loop test may start past 75% with reads and no write, and now hit the deadline. If so:
- Give it a write before its reads, or a smaller history.
- List each such change in the task report.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 6: The approval reviewer judges safety only (#8)

**The problem:** the policy said to return `unsure` when an edit "cannot be fully understood", and for "effects that cannot be independently determined". The 27B read both as "I can't tell whether this code is correct", for example:
- a renamed field;
- overlapping edits;
- an imported API it could not see.

That caused 9 escalations at about 80 s of model swaps each.

**What stays:** every deny rule, and every `unsure` rule for real risk (package installs, pushes, non-recursive deletion, machine-wide changes).

**Files:**
- Modify: `src/repo-search/approval-review-policy.ts:29`, `:49`
- Test: `tests/approval-review-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/approval-review-policy.test.ts`:

```ts
// Real case (run e85529c8): 9 escalations, every one about whether code was correct, none about safety.
test('the approver judges safety only and returns unsure for effects it cannot see, never for correctness', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /^Judge safety only\. Whether a change compiles, overlaps another edit, completes a rename/mu);
  assert.match(APPROVER_SYSTEM_PROMPT, /Never return unsure for those reasons\./u);
  assert.match(APPROVER_SYSTEM_PROMPT,
    /- effects on files, processes, the network, or secrets that cannot be determined from the command and payload shown/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /- non-recursive deletion/u, 'real risks still go to unsure');
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /cannot be fully understood/u);
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /effects that cannot be independently determined/u);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\approval-review-policy.test.ts`
Expected: fails on the first assertion.

- [ ] **Step 3: Reword the two lines**

In `src/repo-search/approval-review-policy.ts`, replace line 29:

```ts
  'If an edit/write payload is missing, malformed, truncated, too large to review, or cannot be fully understood, return unsure.',
```

with:

```ts
  'If an edit/write payload is missing, malformed, truncated, or too large to review, return unsure.',
  'Judge safety only. Whether a change compiles, overlaps another edit, completes a rename, matches code you cannot see, or is right for the task is not a safety question: the edit tool, the checks, and the orchestrator\'s review handle it. Never return unsure for those reasons.',
```

and replace line 49:

```ts
  '- effects that cannot be independently determined',
```

with:

```ts
  '- effects on files, processes, the network, or secrets that cannot be determined from the command and payload shown',
```

- [ ] **Step 4: Run the approval tests**

Run: `node .\src\test-runner\run-tests.ts tests\approval-review-policy.test.ts tests\llm-auto-approval.test.ts tests\approval-verdict-request.test.ts tests\approval-verdict-budget.test.ts tests\auto-approval-verdict-probe.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Live red-team check (needs a model; ask the user first)**

Run: `npm run redteam:approval`

Expected: denials hold, compared with the last recorded result. This loads a model, so get the user's go-ahead first. If it isn't run, report the policy change as unverified against the red-team set.

---

## Task 7: The reviewer sees the script a `run` executes (#10)

**The problem:** when a worker ran its own probe script (`node <scratch>/probe.ts`), the reviewer saw only the command line. It answered `unsure` three times for one probe.

**The fix:** the review request carries the content of each repository script that a non-check `run` executes, and the reviewer judges it like an edit or write payload.
- Checks such as the repository's test runner, `npm test` or `tsc` carry nothing; the policy already approves them.
- A script over 32,000 characters is sent as `null`, and the policy returns `unsure` for it.

**Files:**
- Modify: `src/repo-search/engine/shell-command-policy.ts` (new export)
- Modify: `src/repo-search/engine/approval-gate.ts` (`buildApprovalReviewPayload`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:469`
- Modify: `src/repo-search/approval-review-policy.ts` (one line)
- Test: `tests/approval-review-policy.test.ts`

- [ ] **Step 1: Write the failing test; update the existing calls**

In `tests/approval-review-policy.test.ts`, add imports:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RUN_SCRIPT_REVIEW_MAX_CHARS } from '../src/repo-search/engine/approval-gate.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
```

Merge `RUN_SCRIPT_REVIEW_MAX_CHARS` into the existing `approval-gate.ts` import line.

Add `repoRoot: 'C:\\work\\repo',` to each of the four existing `buildApprovalReviewPayload({ … })` calls: the write, edit, large-edit and review-request tests.

Append:

```ts
const RunPayloadSchema = z.object({ toolName: z.literal('run'), scripts: z.array(z.object({ path: z.string(), content: z.string().nullable() })) });

// Real case (run e85529c8): a probe script escalated three times because the reviewer could see only `node probe.ts`.
test('a run that executes a repository script carries its content for review; checks and inline code carry none', () => {
  const root = createManagedTempDir('siftkit-run-review-');
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.writeFileSync(path.join(root, 'scratch', 'probe.ts'), "console.log('probe');\n");
  fs.writeFileSync(path.join(root, 'scratch', 'big.ts'), 'x'.repeat(RUN_SCRIPT_REVIEW_MAX_CHARS + 1));
  const payload = (command: string) => buildApprovalReviewPayload({ toolName: 'run', args: { command }, repoRoot: root });

  assert.deepEqual(RunPayloadSchema.parse(parseJsonValueText(payload('node .\\scratch\\probe.ts') ?? '')),
    { toolName: 'run', scripts: [{ path: 'scratch/probe.ts', content: "console.log('probe');\n" }] });
  assert.deepEqual(RunPayloadSchema.parse(parseJsonValueText(payload('node scratch/big.ts') ?? '')).scripts,
    [{ path: 'scratch/big.ts', content: null }]);
  for (const command of ['npm test', 'node -e "console.log(1)"', 'node scratch/missing.ts', 'node --test scratch/probe.ts']) {
    assert.equal(payload(command), null, command);
  }
});

test('the approver judges a shown script like an edit payload and returns unsure for one too large to show', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /For run, a payload lists the repository scripts the command executes/u);
});
```

`node --test scratch/probe.ts` is a check invocation, so it carries no script.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\approval-review-policy.test.ts`

Expected: fails, because `RUN_SCRIPT_REVIEW_MAX_CHARS` is not exported and `repoRoot` is an unknown property.

- [ ] **Step 3: Find the scripts a command runs**

In `src/repo-search/engine/shell-command-policy.ts`, add `import fs from 'node:fs';`, and below `findShellReadCommand`:

```ts
const SCRIPT_HOSTS = new Set(['node', 'tsx', 'python', 'python3', 'py', 'pwsh', 'powershell', 'bun', 'deno']);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|tsx|py|ps1)$/iu;

/** Repository files a command runs as scripts (`node probe.ts`, `.\probe.ps1`), outside the repository's own checks. */
export function findRunScripts(command: string, repoRoot: string): Array<{ relativePath: string; absolutePath: string }> {
  const scripts = new Map<string, { relativePath: string; absolutePath: string }>();
  for (const { tokens, offsets, bare, commandStarts } of splitStatements(command)) {
    for (const start of commandStarts) {
      const head = commandHead(tokens, start);
      const offset = offsets[head];
      if (offset === undefined || CHECK_INVOCATION.test(bare.slice(offset))) continue;
      const host = (tokens[head] ?? '').toLowerCase().replace(/\.exe$/u, '');
      const scriptIndex = SCRIPT_HOSTS.has(host) ? tokens.findIndex((token, index) => index > head && !token.startsWith('-')) : head;
      const script = tokens[scriptIndex];
      if (scriptIndex < 0 || script === undefined || !SCRIPT_FILE.test(script)) continue;
      const resolved = resolveRepoScopedPath(repoRoot, path.resolve(repoRoot, script));
      if (resolved !== null && fs.existsSync(resolved.absolutePath) && fs.statSync(resolved.absolutePath).isFile()) {
        const relativePath = resolved.relativePath.replace(/\\/gu, '/');
        scripts.set(resolved.absolutePath, { relativePath, absolutePath: resolved.absolutePath });
      }
    }
  }
  return [...scripts.values()];
}
```

- [ ] **Step 4: Carry the scripts in the payload**

In `src/repo-search/engine/approval-gate.ts`, add `import fs from 'node:fs';` and `import { findRunScripts } from './shell-command-policy.ts';`. Then replace `buildApprovalReviewPayload` with:

```ts
/** Longer scripts are shown as null: the policy returns unsure rather than judge a payload it cannot read whole. */
export const RUN_SCRIPT_REVIEW_MAX_CHARS = 32_000;

export function buildApprovalReviewPayload(input: {
  toolName: string;
  args: JsonObject;
  repoRoot: string;
}): string | null {
  if (input.toolName === 'edit' || input.toolName === 'write') {
    return JSON.stringify({ toolName: input.toolName, args: input.args }, null, 2);
  }
  const command = input.args.command;
  if (input.toolName !== 'run' || typeof command !== 'string') return null;
  const scripts = findRunScripts(command, input.repoRoot).map(({ relativePath, absolutePath }) => {
    const content = fs.readFileSync(absolutePath, 'utf8');
    return { path: relativePath, content: content.length <= RUN_SCRIPT_REVIEW_MAX_CHARS ? content : null };
  });
  return scripts.length === 0 ? null : JSON.stringify({ toolName: 'run', scripts }, null, 2);
}
```

In `src/repo-search/engine/tool-action-processor.ts`, around line 469, add `repoRoot: this.deps.repoRoot,` to the `buildApprovalReviewPayload({ … })` call:

```ts
        reviewPayload: buildApprovalReviewPayload({
          toolName: normalizedToolName,
          args: toolAction.args,
          repoRoot: this.deps.repoRoot,
        }),
```

- [ ] **Step 5: Add the policy line**

In `src/repo-search/approval-review-policy.ts`, after the line that begins `"Approve the repository's own test, build, lint, and typecheck commands`, insert:

```ts
  '',
  'For run, a payload lists the repository scripts the command executes, each with its content (null when too large to show). Judge that content like an edit/write payload: approve a script that only reads or changes files inside the repository, deny one with an effect from the deny lists, and return unsure for null content.',
```

- [ ] **Step 6: Run the tests**

Run: `node .\src\test-runner\run-tests.ts tests\approval-review-policy.test.ts tests\shell-command-policy.test.ts tests\engine-tool-action-processor.test.ts tests\llm-auto-approval.test.ts`
Expected: all pass.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 8: Reviews start from the task's own diff (#12 prompt part, #13)

**What happened in the run:** the `live-flow-sources` review took 38 turns and 21.5 min, against 7–9 turns for the reviews before it.
- It hunted for a diff base: it invented commit `051985a` twice, then used `HEAD~2` and `HEAD~1`, which mix in older unrelated changes.
- It re-checked tasks that had already been reviewed and completed.
- It read code through `run_check` pipelines.

**Why it happened:**
- Nothing told it that the run makes no commits. Every task's change is uncommitted in the working tree, so `HEAD` is the right base and there are no task commits to look up.
- Rule 4 says to review every reported task, but never says to review only that task.

**The fix, in three places:**
1. **Rule 4:**
   - Review only the reported task.
   - The run makes no commits.
   - Start from the `git` tool's diff of each changed path (it compares with `HEAD`), then read the changed code.
   - `run_check` is only for tests and commands.
2. **The report's change list** repeats this where the orchestrator reads it. Its counts are this attempt's own, measured since the attempt began. `git diff HEAD -- <path>` also shows earlier tasks' changes to the same path, and the note says so, so earlier tasks' lines aren't mistaken for this one's.
3. **Task 4** is the harness backstop for reading through `run_check`.

**Files:**
- Modify: `src/orchestrator/prompts.ts:81-83` (rule 4)
- Modify: `src/orchestrator/handoff.ts` (`renderChanges`)
- Test: `tests/orchestrator-prompts.test.ts`, `tests/orchestrator-handoff.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator-prompts.test.ts`:

```ts
// Real case (run e85529c8): a 38-turn review invented a commit hash, diffed against HEAD~2, and re-checked finished tasks.
test('the review step reviews only the reported task, from its uncommitted diff against HEAD', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Review every reported task with record_review, and only that task',
    'completed tasks were already reviewed', 'This run makes no commits',
    'start from the git tool\'s diff (operation diff, path) of each changed path, which compares with HEAD',
    'There are no task commits to look up', 'Use run_check only for tests and commands the review needs, never to read or search']) {
    assert.ok(prompt.includes(rule), rule);
  }
});
```

Append to `tests/orchestrator-handoff.test.ts`:

```ts
test('a report with changes says they are uncommitted and what a diff against HEAD shows', () => {
  const text = renderAttemptForParent(result(), DIFFSTAT);
  assert.match(text, /- tests\/store\.test\.ts \+40 -0 \(new\)\nUncommitted, like every change in this run: the git tool's diff of a path compares it with HEAD and also shows earlier tasks' changes to that path; the counts above are this attempt's own\./u);
  assert.doesNotMatch(renderAttemptForParent(result(), []), /Uncommitted/u);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts tests\orchestrator-handoff.test.ts`
Expected: both new tests fail.

- [ ] **Step 3: Rewrite rule 4's opening**

In `src/orchestrator/prompts.ts`, replace lines 81–83:

```ts
    '4. Review every reported task with record_review. A report gives the child\'s status, where it departed from the plan,',
    '   the gate\'s last check results, and what changed as line counts, not the code: read the changed code yourself, and use',
    '   run_check for any test or command the review needs.',
```

with:

```ts
    '4. Review every reported task with record_review, and only that task: completed tasks were already reviewed, so do not',
    '   re-check them. A report gives the child\'s status, where it departed from the plan, the gate\'s last check results, and',
    '   what changed as line counts, not the code. This run makes no commits: every task\'s changes stay uncommitted in the',
    '   working tree, so start from the git tool\'s diff (operation diff, path) of each changed path, which compares with HEAD,',
    '   then read the changed code yourself. There are no task commits to look up. Use run_check only for tests and commands',
    '   the review needs, never to read or search.',
```

The existing assertions `'Review every reported task'` and `'line counts, not the code'` still hold.

- [ ] **Step 4: Add the note to the report**

In `src/orchestrator/handoff.ts`, above `renderChanges`:

```ts
// The base a review should diff against; run e85529c8 invented commit hashes and diffed against HEAD~2 without it.
const UNCOMMITTED_CHANGES_NOTE = 'Uncommitted, like every change in this run: the git tool\'s diff of a path compares it with HEAD'
  + ' and also shows earlier tasks\' changes to that path; the counts above are this attempt\'s own.';
```

In `renderChanges`, change the final `}).join('\n')}\`;` to append the note:

```ts
  }).join('\n')}\n${UNCOMMITTED_CHANGES_NOTE}`;
```

The empty case still returns `'Changes: none.'` and carries no note.

- [ ] **Step 5: Run the orchestrator suites**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts tests\orchestrator-handoff.test.ts tests\orchestrator-runs.test.ts`

Expected: all pass. The handoff test's `< 2_500` length bound still holds; the note adds about 170 characters.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 9: Workers leave the full checks to the gate (#7)

**The problem:** each fix attempt ran the full dashboard suite, typecheck and lint 9–14 times, and then the gate ran the task's checks again.

**The fix:** workers run only the tests for what they change, plus typecheck once before finishing. The gate still runs every check and sends failures back, so nothing goes unverified.

**Files:**
- Modify: `src/orchestrator/prompts.ts:135`
- Test: `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator-prompts.test.ts`:

```ts
// Real case (run e85529c8): each fix ran the full suites 9-14 times before the gate ran them again.
test('a child runs only the tests for what it changes and leaves the full checks to the gate', () => {
  const instruction = buildChildInstruction({ work: work('fix'), attempt: 1, repoRoot: 'C:/work/repo', scratchPath: 's', preexistingDirtyPaths: [] });
  assert.ok(instruction.includes('While you work, run only the test files for the code you change, and the typecheck once before you finish;'
    + ' do not run the full suites or lint yourself: code runs every check above when you finish and returns failures to you.'), instruction);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts`
Expected: fails.

- [ ] **Step 3: Add the line after the checks list**

In `src/orchestrator/prompts.ts`, below line 135 (`'Checks (code runs every command check when you finish; they must pass):', ...task.verification.map(...)`), insert:

```ts
    'While you work, run only the test files for the code you change, and the typecheck once before you finish; do not run the'
      + ' full suites or lint yourself: code runs every check above when you finish and returns failures to you.',
```

- [ ] **Step 4: Run the prompt tests**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 10: A plan restructure takes one call (#15)

**What happened:** "at most 4 tasks per call" is a prompt rule only; nothing in code enforces it. The model followed it anyway. Retiring 2 tasks, adding 3 and rewiring 4 is nine changes, which took six calls, five of them refused. Each partial call left an invalid plan.

**Why one call is safe:** the code already validates a whole call at once, including retirements and repointed dependents together.

**The fix:**
- The rule counts only new tasks.
- Both refusals name the fix: do it in this same call.

**Files:**
- Modify: `src/orchestrator/prompts.ts:67-68` (rule 2)
- Modify: `src/orchestrator/plan-state.ts:76`
- Modify: `src/orchestrator/plan.ts:51`
- Test: `tests/orchestrator-prompts.test.ts`, `tests/orchestrator-plan-state.test.ts`, `tests/orchestrator-plan.test.ts`

- [ ] **Step 1: Move the tests to the new wording (they fail first)**

In `tests/orchestrator-prompts.test.ts`, replace the body of `'the orchestrator adds implementation tasks in small batches in dependency order'` with:

```ts
  const prompt = buildOrchestratorPrompt(brief());
  assert.ok(prompt.includes('adding at most 4 new tasks per save_plan or update_tasks call'), prompt);
  // Real case (run e85529c8): a retire-2, add-3, rewire-4 restructure took six calls, five refused.
  assert.ok(prompt.includes('A restructure is one update_tasks call: add the replacements, repoint the dependents\' dependsOn,'
    + ' and retire the old tasks together; retirements and changes to existing tasks do not count toward the 4.'), prompt);
```

In `tests/orchestrator-plan-state.test.ts:63`, change the expected problem to:

```ts
    { ok: false, problems: ["Task 'b' depends on a, which this call retires: in this same call, retire it too or set its dependsOn."] });
```

In `tests/orchestrator-plan.test.ts`, change the missing-dependency case to:

```ts
  ['a missing dependency', [makeOrchestratorTask({ dependsOn: ['ghost'] })],
    /Task 'inspect' depends on missing task 'ghost': add 'ghost' in this same call, or remove it from dependsOn\./u],
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts tests\orchestrator-plan-state.test.ts tests\orchestrator-plan.test.ts`
Expected: the three changed expectations fail.

- [ ] **Step 3: Change the prompt and both refusals**

In `src/orchestrator/prompts.ts`, replace lines 67–68:

```ts
    '2. Call save_plan with the implementation tasks in dependency order, at most 4 tasks per save_plan or update_tasks call,',
    '   and add the rest with update_tasks, so a malformed call costs little to resend. Planning rules:',
```

with:

```ts
    '2. Call save_plan with the implementation tasks in dependency order, adding at most 4 new tasks per save_plan or update_tasks call,',
    '   and add the rest with update_tasks, so a malformed call costs little to resend. A restructure is one update_tasks call: add',
    '   the replacements, repoint the dependents\' dependsOn, and retire the old tasks together; retirements and changes to',
    '   existing tasks do not count toward the 4. Planning rules:',
```

`src/orchestrator/plan-state.ts:76`:

```ts
      problems.push(`Task '${task.id}' depends on ${gone.join(', ')}, which this call retires: in this same call, retire it too or set its dependsOn.`);
```

`src/orchestrator/plan.ts:51`:

```ts
      if (!byId.has(dependency)) throw new Error(`Task '${task.id}' depends on missing task '${dependency}': add '${dependency}' in this same call, or remove it from dependsOn.`);
```

- [ ] **Step 4: Run the orchestrator suites**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts tests\orchestrator-plan-state.test.ts tests\orchestrator-plan.test.ts tests\orchestrator-runs.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 11: Plan write paths are checked for size and duplicates (#16, #17)

**When the checks run:** on every `save_plan` and `update_tasks`, but only for tasks whose `writePaths` the call adds or changes. A task the call leaves alone is never refused again.

**The two checks:**
- **At most 8 write paths per task.** The tasks with 11 and 13 paths were exactly the ones that compacted mid-task or stalled. The prompt's "about 6" was never enforced.
- **No new test file whose name already exists elsewhere.** The run planned `dashboard/tests/hooks/use-orchestrator-run.test.tsx` beside the existing `dashboard/tests/use-orchestrator-run.test.tsx`, which cost a failed review and a fix cycle. Only test files are checked, because names like `index.ts` legitimately repeat.

**Files:**
- Modify: `src/orchestrator/plan.ts` (new export)
- Modify: `src/orchestrator/workspace.ts` (new export `listRepositoryFiles`)
- Modify: `src/orchestrator/run.ts` (`storePlan`)
- Modify: `src/orchestrator/prompts.ts:69-70` (rule 2 wording)
- Test: `tests/orchestrator-plan.test.ts`, `tests/process/orchestrator-workspace.test.ts`, `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/orchestrator-plan.test.ts`:

```ts
import { findPlanPathProblems, findTestPathsOutsideScope, ORCHESTRATOR_MAX_WRITE_PATHS, validateOrchestratorPlan } from '../src/orchestrator/plan.ts';
```

Append:

```ts
const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/f${index}.ts`);

// Real case (run e85529c8): the 11- and 13-path tasks compacted mid-task or stalled; the prompt's limit was never enforced.
test('a new or widened task over the write-path limit is refused; one the call leaves alone is not judged again', () => {
  const wide = makeOrchestratorTask({ id: 'wide', writePaths: paths(ORCHESTRATOR_MAX_WRITE_PATHS + 1) });
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([wide]), []), [
    `Task 'wide' lists ${ORCHESTRATOR_MAX_WRITE_PATHS + 1} writePaths; a task may change at most ${ORCHESTRATOR_MAX_WRITE_PATHS} paths.`
      + ' Split it into tasks that each finish within one worker context.',
  ]);
  const saved = makeOrchestratorPlan([wide]);
  assert.deepEqual(findPlanPathProblems(saved, saved, []), []);
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([makeOrchestratorTask({ writePaths: paths(ORCHESTRATOR_MAX_WRITE_PATHS) })]), []), []);
});

// Real case (run e85529c8): a planned hooks/use-orchestrator-run.test.tsx duplicated the existing test file of that name.
test('a task that creates a test file whose name exists elsewhere is refused; existing paths and source files are not', () => {
  const files = ['dashboard/tests/use-run.test.tsx', 'src/index.ts'];
  const task = makeOrchestratorTask({ id: 'hook',
    writePaths: ['dashboard/tests/hooks/use-run.test.tsx', 'src/lib/index.ts', 'dashboard/tests/use-run.test.tsx'] });
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([task]), files), [
    "Task 'hook' creates 'dashboard/tests/hooks/use-run.test.tsx', but 'dashboard/tests/use-run.test.tsx' already exists:"
      + ' name the existing test file, or give a new file a name that says how it differs.',
  ]);
});
```

In `tests/process/orchestrator-workspace.test.ts`, add `listRepositoryFiles` to the `workspace.ts` import and append:

```ts
test('the repository file list holds tracked and untracked files as POSIX paths, without ignored ones', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'x');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'new.test.ts'), 'x');
  assert.deepEqual((await listRepositoryFiles(root)).sort(), ['.gitignore', 'README.md', 'src/a.ts', 'tests/new.test.ts']);
});
```

In `tests/orchestrator-prompts.test.ts`, in `'the orchestrator prompt carries the planning rules that keep tasks small and fully verified'`, change `'at most about 6 write'` to `'about 6 write paths, never more than 8'`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-plan.test.ts tests\process\orchestrator-workspace.test.ts tests\orchestrator-prompts.test.ts`
Expected: fails; the new exports are missing and the prompt wording is old.

- [ ] **Step 3: Implement `findPlanPathProblems`**

In `src/orchestrator/plan.ts`, below `findTestPathsOutsideScope` (it reuses the `TEST_PATH` constant above it):

```ts
/** The most files one task may expect to change; larger tasks compacted mid-task or stalled in run e85529c8. */
export const ORCHESTRATOR_MAX_WRITE_PATHS = 8;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Problems with the write paths a save_plan or update_tasks call adds or changes: too many for one worker, or a new
 * test file whose name already exists elsewhere. Tasks whose writePaths the call leaves alone are not judged again.
 */
export function findPlanPathProblems(previous: OrchestratorPlan | null, next: OrchestratorPlan, repositoryFiles: readonly string[]): string[] {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task.writePaths.join('\n')]));
  const existing = new Set(repositoryFiles);
  const byName = new Map<string, string[]>();
  for (const file of repositoryFiles) byName.set(fileName(file), [...(byName.get(fileName(file)) ?? []), file]);
  const problems: string[] = [];
  for (const task of next.tasks) {
    if (before.get(task.id) === task.writePaths.join('\n')) continue;
    if (task.writePaths.length > ORCHESTRATOR_MAX_WRITE_PATHS) {
      problems.push(`Task '${task.id}' lists ${task.writePaths.length} writePaths; a task may change at most ${ORCHESTRATOR_MAX_WRITE_PATHS} paths.`
        + ' Split it into tasks that each finish within one worker context.');
    }
    for (const writePath of task.writePaths) {
      if (existing.has(writePath) || !TEST_PATH.test(writePath)) continue;
      const twins = byName.get(fileName(writePath)) ?? [];
      if (twins.length === 0) continue;
      problems.push(`Task '${task.id}' creates '${writePath}', but ${twins.map((twin) => `'${twin}'`).join(', ')} already exists:`
        + ' name the existing test file, or give a new file a name that says how it differs.');
    }
  }
  return problems;
}
```

- [ ] **Step 4: Implement `listRepositoryFiles`**

In `src/orchestrator/workspace.ts`, below `listDirtyPaths`:

```ts
/** Tracked and untracked files that are not ignored, as repository-relative POSIX paths. */
export async function listRepositoryFiles(repoRoot: string): Promise<string[]> {
  return (await git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter((entry) => entry.length > 0);
}
```

- [ ] **Step 5: Check paths when a plan is stored**

In `src/orchestrator/run.ts`, add `findPlanPathProblems` to the `./plan.ts` import and `listRepositoryFiles` to the `./workspace.ts` import. In `storePlan`, right after the `try { plan = validateOrchestratorPlan(…) } catch …` block:

```ts
    const repositoryFiles = await this.withRepository(() => listRepositoryFiles(this.request.repoRoot));
    const pathProblems = findPlanPathProblems(this.state.plan, plan, repositoryFiles);
    if (pathProblems.length > 0) return pathProblems;
```

`this.state.plan` is the stored plan from before this call: already normalized, and `null` before the first `save_plan`.

- [ ] **Step 6: Update rule 2's wording**

In `src/orchestrator/prompts.ts`, replace lines 69–70:

```ts
    '   - One task is one concern a worker finishes within about half its context: a handful of files (at most about 6 write',
    '     paths) and their tests. Split anything larger.',
```

with:

```ts
    '   - One task is one concern a worker finishes within about half its context: a handful of files (about 6 write paths,',
    '     never more than 8) and their tests. Split anything larger. Name an existing test file for a module; plan a new test',
    '     file only after find shows none exists.',
```

- [ ] **Step 7: Run the orchestrator suites, including process tests**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-plan.test.ts tests\process\orchestrator-workspace.test.ts tests\orchestrator-prompts.test.ts tests\orchestrator-runs.test.ts tests\process\orchestrator-run.e2e.test.ts`

Expected: all pass. The e2e test goes through `storePlan` with real git, so it covers the wiring.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 12: Planning prompt: spec first, batched reads, instructions as final decisions (#18, prompt part)

**What happened in the run:**
- The orchestrator made exactly one call per turn while planning: 50 calls in 50 turns, about 13 s each.
- It opened the named spec only at turn 30, and read it out of order.
- One instruction kept a self-correction ("— actually attach to the CHILD"), so the worker got both options.

**Files:**
- Modify: `src/orchestrator/prompts.ts:62-64` (rule 1), `:78-79` (rule 3)
- Test: `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator-prompts.test.ts`:

```ts
// Real case (run e85529c8): one call per turn for 50 turns, the spec opened at turn 30, and "— actually" left in an instruction.
test('the orchestrator reads the named spec whole first, batches independent reads, and writes instructions as final decisions', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Read the requirements first, before any other exploration: the task, then every spec or plan it names,',
    'each read whole from start to end', 'Issue independent reads, greps, and finds together in one turn',
    'Write each instruction as final decisions, each step stated once']) {
    assert.ok(prompt.includes(rule), rule);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts`
Expected: fails.

- [ ] **Step 3: Rewrite the start of rule 1**

In `src/orchestrator/prompts.ts`, replace lines 62–64:

```ts
    '1. Read the requirements: the task and any spec or plan it names. Explore the code yourself with read, grep, find, ls, and git',
    '   until you can name every file each change touches and the tests that cover it. Read narrowly: grep for symbols and read',
    '   line ranges, not whole directories; your context also has to hold every review.',
```

with:

```ts
    '1. Read the requirements first, before any other exploration: the task, then every spec or plan it names,',
    '   each read whole from start to end. Explore the code yourself with read, grep, find, ls, and git until you can name',
    '   every file each change touches and the tests that cover it. Read narrowly: grep for symbols and read line ranges, not',
    '   whole directories; your context also has to hold every review. Issue independent reads, greps, and finds together in one',
    '   turn; call them one at a time only when the next depends on the last result.',
```

The existing assertion `'Explore the code yourself with read, grep, find, ls, and git'` still holds.

- [ ] **Step 4: Add the instruction-writing rule to rule 3**

Replace lines 78–79:

```ts
    '   include what it must change, the files and lines you found, what earlier tasks changed that matters to it, and the',
    `   pitfalls you already know. dispatch waits until the child reports. Code runs a child's checks each time it finishes;`,
```

with:

```ts
    '   include what it must change, the files and lines you found, what earlier tasks changed that matters to it, and the',
    '   pitfalls you already know. Write each instruction as final decisions, each step stated once: never leave a corrected',
    `   option ("— actually") in it. dispatch waits until the child reports. Code runs a child's checks each time it finishes;`,
```

- [ ] **Step 5: Run the prompt tests**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts`
Expected: all pass.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 13: Omitted task lists default to empty (#18, schema part)

**What happened:** the run's first `save_plan` failed because one task had no `temporaryPaths`. Resending cost a round trip and about 7k tokens, right at the plan deadline.

**The fix:** `dependsOn`, `readPaths` and `temporaryPaths` default to empty when omitted. Wrong types are still refused.

**The one thing to avoid:** an `update_tasks` patch must never pick up these defaults. If it did, a patch that only renames a task would erase its dependencies. So patches keep a schema with no defaults. An existing test already guards this.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts:49-63`, `:290`
- Test: `tests/contracts-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/contracts-orchestrator.test.ts`:

```ts
// Real case (run e85529c8): a first save_plan without temporaryPaths cost a round trip at the plan deadline.
test('a plan task may omit its dependency, read, and temporary lists; wrong types are still refused', () => {
  const minimal = { id: 'a', title: 'A', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'],
    steps: [{ instruction: 'Change it.', expectedResult: 'Changed.' }],
    verification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }], acceptance: ['Changed.'] };
  const task = OrchestratorTaskSchema.parse(minimal);
  assert.deepEqual([task.dependsOn, task.readPaths, task.temporaryPaths], [[], [], []]);
  assert.equal(OrchestratorTaskSchema.safeParse({ ...minimal, temporaryPaths: 'scratch' }).success, false);
  assert.equal(OrchestratorTaskSchema.safeParse({ ...minimal, extra: true }).success, false, 'still strict');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\contracts-orchestrator.test.ts`
Expected: fails; the minimal task does not parse.

- [ ] **Step 3: Split the schema**

In `packages/contracts/src/orchestrator.ts`, replace the `OrchestratorTaskSchema` declaration (lines 49–62) with:

```ts
/** A plan task's fields exactly as written; update_tasks patches use this shape so a patch never gains a default. */
const OrchestratorTaskFieldsSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1),
  dependsOn: z.array(z.string().min(1)),
  workerPresetId: z.string().trim().min(1),
  readPaths: z.array(z.string().min(1)),
  writePaths: z.array(z.string().min(1)),
  steps: z.array(z.object({
    instruction: z.string().trim().min(1), expectedResult: z.string().trim().min(1),
  }).strict()).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  temporaryPaths: z.array(z.string().min(1)),
}).strict();

/** A plan task; omitted dependency, read, and temporary lists mean none. */
export const OrchestratorTaskSchema = OrchestratorTaskFieldsSchema.extend({
  dependsOn: OrchestratorTaskFieldsSchema.shape.dependsOn.default([]),
  readPaths: OrchestratorTaskFieldsSchema.shape.readPaths.default([]),
  temporaryPaths: OrchestratorTaskFieldsSchema.shape.temporaryPaths.default([]),
}).strict();
```

At line 290, change `set: OrchestratorTaskSchema.omit({ id: true }).partial().strict(),` to:

```ts
    taskId: z.string().min(1), set: OrchestratorTaskFieldsSchema.omit({ id: true }).partial().strict(),
```

- [ ] **Step 4: Run the contract and orchestrator tests**

Run: `node .\src\test-runner\run-tests.ts tests\contracts-orchestrator.test.ts tests\orchestrator-plan-state.test.ts tests\repo-search-orchestrator-tools.test.ts tests\orchestrator-plan.test.ts`

Expected: all pass, including `'a task names its writePaths, a check fills its obvious defaults, and a partial task update never gains a default'`.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`, then `npm run build`.
Expected: both exit 0. The build covers the contracts package that the dashboard consumes.

---

## Task 14: Cache-break warnings only for real breaks (#18, warning part)

**The problem:** the cache watch warned about a 1.9k-token re-prefill on turn 189 with the same text it used for the real 165k break. Re-prefilling a few pages is the engine rolling back, not a lost cache.

**The fix:**
- Raise the threshold from 500 tokens to 8,192 (32 pages).
- Rename the constant to say what it now means.

**Files:**
- Modify: `src/repo-search/engine/prompt-cache-watch.ts:4-5`, `:28`
- Test: `tests/prompt-cache-watch.test.ts`

- [ ] **Step 1: Move the tests to the new threshold (they fail first)**

In `tests/prompt-cache-watch.test.ts`:
- Rename `PROMPT_CACHE_BREAK_TOLERANCE_TOKENS` to `PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS` everywhere.
- Change the expected `promptEvalTokens: 1_501` to `promptEvalTokens: 1_000 + PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS + 1`.

Replace the body of `'the first response after a compaction is not checked, and the next one is'` with:

```ts
  const watch = new PromptCacheWatch();
  observe(watch, 1, 50_000, 50_000);
  watch.noteCompaction();
  assert.equal(observe(watch, 2, 20_000, 20_000), null);
  assert.equal(observe(watch, 3, 21_000, 21_000)?.turn, 3);
```

Append:

```ts
// Real case (run e85529c8, turn 189): 7,281 re-prefilled where the prompt grew 5,354 was warned like the real 165k break.
test('a re-prefill of a few pages beyond the growth is not reported', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 100_347, 100_347);
  assert.equal(observe(watch, 2, 105_701, 7_281), null);
  assert.equal(PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS, 8_192);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests\prompt-cache-watch.test.ts`
Expected: fails; the renamed export is missing.

- [ ] **Step 3: Raise and rename the threshold**

In `src/repo-search/engine/prompt-cache-watch.ts`, replace:

```ts
/** Absorbs differences between SiftKit's prompt token count and the engine's. */
export const PROMPT_CACHE_BREAK_TOLERANCE_TOKENS = 500;
```

with:

```ts
/** Re-prefill beyond the prompt's growth that counts as a broken cache: count differences and a few rolled-back pages do not. */
export const PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS = 8_192;
```

On line 28, change `PROMPT_CACHE_BREAK_TOLERANCE_TOKENS` to `PROMPT_CACHE_BREAK_MIN_EXCESS_TOKENS`. Confirm nothing else uses the old name: `grep -rn "PROMPT_CACHE_BREAK_TOLERANCE_TOKENS" src tests dashboard` should print nothing.

- [ ] **Step 4: Run the cache tests**

Run: `node .\src\test-runner\run-tests.ts tests\prompt-cache-watch.test.ts tests\prompt-cache-break-loop.test.ts`

Expected: all pass. The loop test's break re-prefills 1,000,000 tokens and its intact case only 10, so both stay on the right side of the new threshold.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

---

## Final verification (after all tasks)

- [ ] `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and file:line anchors."`. Run `npm test` on its own if SiftKit is not running.
- [ ] `npm run test:dashboard` (Task 13 changes a contract the dashboard consumes).
- [ ] `npm run typecheck` (this includes lint).
- [ ] With the user's go-ahead, re-run the e85529c8 task (same spec, same baseline) on both orchestrator presets to measure the effect.
