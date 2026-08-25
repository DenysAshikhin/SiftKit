# Native Planner Protocol Design

**Status:** Approved for planning
**Date:** 2026-08-25

## Goal

Delete SiftKit's hand-authored planner action envelope and let the model's own tool-calling format be the protocol. One format, authored by nobody, used identically for what the model is taught, shown, and checked on.

## Starting state

The working tree carries the uncommitted result of the prior plan (`docs/superpowers/plans/2026-08-25-planner-format-consistency-and-invalid-action-corpus.md`): Tasks 1-3 and 5-7 implemented and green (3383 tests, typecheck, lint), Task 4 implemented but **live-verified broken** — TabbyAPI returns HTTP 422 for object `function.arguments`. Nothing is committed. This design supersedes that plan's remaining intent: Tasks 1-3 hardened the envelope's error feedback, and the envelope itself is what is being removed.

## Problem

SiftKit asks the model to emit a JSON action envelope:

```json
{"action":"tool","toolName":"git","args":{"operation":"status"}}
```

Nothing else in the request uses that format. Three concrete divergences, all verified this session:

1. **The model's own history is rendered in a different format than it is asked to produce.** Planner requests send `tools: []` (`src/repo-search/planner-protocol.ts:486`), so the chat template's `{% if tools %}` instruction block is never injected — the model is *not* told to emit XML. But assistant history is replayed as `tool_calls`, and the template's message loop renders those as `<tool_call><function=git><parameter=operation>status</parameter></function></tool_call>` regardless. The model has never seen a correctly-formatted example of the envelope in the one place it looks hardest: its own successful turns.

2. **Constrained decoding is not preventing malformed actions.** `response_format: json_schema` carries the action schema (`src/repo-search/planner-protocol.ts:471`), yet `tests/fixtures/invalid-action-corpus.json` holds real payloads like `"args": "operation=ls_files path=."` and `"args": ["status"]`. Enforcement is suspected broken; a tripwire for this was already deferred as item #1 of the prior plan.

3. **The envelope carries one thing per turn, so narration has nowhere to go.** Documented in `docs/superpowers/plans/2026-08-21-progress-action-context-count-shim.md:27`: run `b3f9c83a` emitted `finish` with output "…Continuing with implementation now." at turn 10/100, reporting a half-finished task as `completed`. The fix was to add a `progress` action so narration had a channel.

Each symptom got its own construct. The pattern is the cause: a bespoke protocol competing with the model's trained behavior.

| Symptom | Patch shipped | Native equivalent |
|---|---|---|
| Narration surfaced as premature `finish` | `progress` action | `content` alongside `tool_calls` |
| `"args":"<string>"`, `"args":["status"]` | canonical-format feedback module | args are structured by construction |
| Batch calls | `tool_batch` action + schema | multiple `tool_calls` |

The summary planner is the sharpest case: it already sends real `tools` (`src/summary/planner/mode.ts:568`) **and** enforces the envelope schema, then converts any returned `tool_calls` back into envelope text (`src/providers/llama-cpp.ts:233`). It runs both protocols at once.

## Target design

The model's response *is* the action. No envelope, no action layer.

| Model response | Interpretation |
|---|---|
| `tool_calls` present | tool actions (n entries = batch, free) |
| `content` + `tool_calls` | narration + actions in one turn |
| `content`, no `tool_calls` | finish; the content is the answer |
| neither | invalid; nudge and count a strike |

SiftKit authors no format. It sends standard `tools`, receives standard `tool_calls`, and the chat template — the same one that renders replayed history — owns the dialect. Show/emit symmetry is structural, not maintained by discipline, and it survives a model swap.

### The single seam

`AgentLoopActionParser` (`src/agent-loop/action-parser.ts`) already produces the format-neutral internal type `AgentLoopAction` with kinds `tool | progress | finish`. That type and everything downstream of it stay exactly as they are: `TaskLoop.handleProgress`, `evaluateFinish`, the approval gate, forced finish, duplicate tracking, budgets.

Only the *source* changes. One module owns one function:

```
PlannerResponse (content, toolCalls) -> AgentLoopAction[]
```

The same tool-definition list is simultaneously what gets sent as `tools`, what the parser accepts, and what validates arguments. There is nothing to keep in step because there is only one list.

### Component boundaries

| Component | Owns | Depends on |
|---|---|---|
| `src/planner-protocol/native-actions.ts` (new) | `PlannerResponse -> AgentLoopAction[]`; per-tool argument validation; the invalid-response decision | tool definitions, zod arg schemas |
| `toProtocolTools` (`src/providers/llama-cpp.ts:198`) | tool definitions -> wire `tools` | tool definitions |
| `LlamaCppToolCallParser` (`src/llm-protocol/tool-call-parser.ts`) | dialect text -> `tool_calls`, when the backend does not parse | none (already matches this template's dialect) |
| `AgentLoopActionParser` | thin adapter to the new module; no format knowledge | native-actions module |
| Tool registries (`repo-tool-arguments.ts`, `summary-tools.ts`) | argument schemas, unchanged | none |

### Data flow

**Request.** Planner requests send `tools: toProtocolTools(definitions)` instead of `[]`, and drop the action `response_format`. Structured-output `response_format` stays for genuinely structured, non-action responses: finish validation and the approval verdict probe. Those are not actions and JSON schema is the correct tool for them.

**Response.** Read `content` and `tool_calls` from the provider response. If `tool_calls` is empty and the content contains dialect text, fall back to `LlamaCppToolCallParser.parseFromText`. Map to `AgentLoopAction[]`:

- each tool call -> `{kind:'tool', callId, toolName, args}`, args validated against that tool's schema
- non-empty content with tool calls -> a leading `{kind:'progress', text}`
- non-empty content without tool calls -> `{kind:'finish', text}`
- nothing usable -> invalid response

**Replay.** Unchanged in shape and now correct by definition: assistant messages carry `tool_calls` with string `arguments`, paired with `role:tool` results. The template renders them in the same dialect the model produces.

**Error feedback.** An invalid or unknown tool call is answered as the `role:tool` result for *that call id* — the standard mechanism, scoped to the failing call, instead of a free-floating user message. `canonical-format.ts` becomes unnecessary: there is no canonical example to teach when the format is the model's own.

### Summary planner

Gets a `finish` tool whose parameters are the existing fields:

```
finish(classification: 'summary'|'command_failure'|'unsupported_input',
       raw_review_required: boolean,
       output: string)
```

`SummaryPlannerFinishActionSchema` (`src/planner-protocol/summary.ts:31`) becomes that tool's `parameters`; the zod schemas are reused, not rewritten. This is the one place where a `finish` tool is used rather than the implicit "content = answer" signal, because a classification cannot ride in prose. It is also the riskiest part of the change — summary trades a guaranteed response schema for tool-call compliance — so the summary benchmark gates it.

### Deleted

After verification passes, in a dedicated task:

- `buildPlannerActionJsonSchema`, `buildPlannerToolActionExample`, `buildPlannerToolInstructions`
- `parseRepoSearchPlannerAction`, `parseSummaryPlannerAction`, `PlannerToolActionEnvelopeSchema`, `PlannerToolBatchEnvelopeSchema`, `PlannerActionParseError`
- `src/planner-protocol/canonical-format.ts` and `tests/planner-canonical-format.test.ts` (built this session)
- `tests/planner-invalid-corpus.test.ts`, `tests/fixtures/invalid-action-corpus.json`, `scripts/extract-invalid-action-corpus.ts`
- `StreamingFinishOutputExtractor` (~200 lines in `src/lib/model-json.ts`)
- the `progress` action, its schema, and `getStructuredToolCallText`

`scripts/report-invalid-action-rate.ts` survives: it measures the new protocol too.

**Prerequisite revert.** Task 4 of the prior plan (object `function.arguments`) reverts first. Native replay sends standard `tool_calls` with string `arguments`; the object form returns HTTP 422 from TabbyAPI's request schema, verified live this session.

**`progress` dies immediately**, not as a deprecated no-op sink. Narration-in-content replaces it in the same change.

## Error handling and edge cases

| Case | Handling |
|---|---|
| Content with no tool calls, mid-task | Finish signal. `FinishVerificationGate` and `minToolCallsBeforeFinish` gate it exactly as today; rejection appends a user message and the loop continues. |
| Empty content, no tool calls | Invalid response; strike counted; nudge message. Existing `maxInvalidResponses` limit applies. |
| Unknown or disallowed tool name | `role:tool` error result naming the allowed tools. Strike counted. |
| Arguments fail the tool's zod schema | `role:tool` error result quoting the failing field. Strike counted. |
| Backend returns dialect text instead of parsed `tool_calls` | `LlamaCppToolCallParser.parseFromText` fallback; no strike. |
| Zero-output finish | Content is empty and no tool calls -> treated as invalid, not as a finish. Forced-finish controller unchanged. |
| Streaming | Content deltas stream live as narration; classification into answer-vs-narration happens at turn end when `tool_calls` presence is known. **Accepted trade-off:** the answer is no longer styled as an answer *during* the stream, only after. Live text still appears in the CLI and dashboard throughout. |

## Testing strategy

**Mock responses are the bulk of the work.** `mockResponses: string[]` (envelope text) becomes a typed fixture parsed with zod:

```ts
const MockPlannerResponseSchema = z.object({
  content: z.string().default(''),
  thinking: z.string().default(''),
  toolCalls: z.array(z.object({ name: z.string(), arguments: JsonObjectSchema })).default([]),
});
```

Every test that drives the loop with envelope strings migrates to this shape. The suite currently passes 3383 tests; none may be weakened to accommodate the change.

New coverage:

- response -> action mapping for all five rows of the response table
- argument validation failures land as `role:tool` results on the right call id
- dialect-text fallback when `tool_calls` is absent
- summary `finish` tool round-trip preserving classification and `raw_review_required`
- replay round-trip: actions -> `tool_calls` -> rendered -> parsed back

## Verification and rollout

Native is the only live path once switched. Envelope code stays on disk, unreferenced, until the bar is met. There is no feature flag: rollback is `git revert`, not a toggle.

**Phase 0 spike — hard stop.** Against the live backend, verify that TabbyAPI returns parsed `tool_calls` for this template and whether tool-call output can be constrained. If tool calls come back unparsed, the existing dialect parser covers it. **If they are neither reliably parsed nor constrainable, the plan stops and the design is reconsidered.** No further tasks begin until this answers cleanly.

**Baselines captured on the envelope build, before any switch:**

- `npm run benchmark` — summary classification and `raw_review_required` on the fixture corpus
- `npx tsx scripts/report-invalid-action-rate.ts --since 2026-08-24` — repo-search invalid-action rate (recorded baseline: 68 runs, 2 with invalid actions, 2 killed by `invalid_response_limit`, 8 strikes all attributed to `git`)

**Pass bar, all required:**

- summary classification and raw-review parity or better against baseline
- repo-search invalid-action rate at or below baseline
- one repo-agent task completed end-to-end through the approval gate
- finishes reviewed by hand for premature stops — the specific failure that created `progress`
- full suite, `npm run typecheck`, and lint green

Only then does the deletion task run.

## Out of scope

- Changing tool surfaces, argument schemas, or tool behavior
- The approval-verdict and finish-validation `response_format` paths (genuinely structured, correctly using JSON schema)
- Prompt-cache and compaction tuning
- Dashboard rendering beyond what the removal of `progress` forces

## Risks

| Risk | Mitigation |
|---|---|
| Tool-call output cannot be constrained | Phase 0 spike hard-stops the plan before any code changes |
| Premature finish on chatty turns | Verification bar reviews finishes explicitly; verification gate and min-tool-calls unchanged |
| Summary loses schema guarantees | Summary benchmark parity is a gate, not a nice-to-have |
| Large test migration hides a behavior regression | No test may be weakened; new mapping tests added before migration |
| Dialect changes on model swap | The template owns the dialect; the fallback parser is dialect-specific and would need updating — noted, not solved here |
