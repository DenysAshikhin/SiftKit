# Duplicate Tool-Call Transcript Cost

## 1. The Guard Is Necessarily Reactive

`ToolActionProcessor` computes `duplicateFingerprint` and calls `rejectAsDuplicate` ([tool-action-processor.ts:441-451](src/repo-search/engine/tool-action-processor.ts#L441-L451)) only after the model has already streamed the entire tool call. There is no pre-generation short-circuit and none is possible — the fingerprint derives from arguments that do not exist until generation completes. Any claim the duplicate could be caught earlier is wrong.

## 2. What the Rejection Reclaims: Only the Tool Result

`rejectAsDuplicate` replaces the *tool* message via `transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage)` at [tool-action-processor.ts:481](src/repo-search/engine/tool-action-processor.ts#L481), or appends a fresh 66-character tool message reading `duplicate command requested x2. Issue a different/unique tool call` ([tool-loop-governor.ts:188](src/tool-loop-governor.ts#L188)). The assistant message carrying the rejected `tool_calls` arguments is NEVER touched.

## 3. What That Cost in Run b62673ac-a814-4c70-b8e8-5b6b217d7c1a

Run b62673ac-a814-4c70-b8e8-5b6b217d7c1a (2026-08-04T01:31Z, 69 turns, failed at the 15-minute budget). These figures are verified against the stored transcript:

- **Turn 37:** prompt 76,207 tokens, one call, id `call_40`, 69 chars of arguments
- **Turn 38:** prompt 89,340 tokens, one call, id `duplicate_call_41`, 52,400 chars of arguments
- **Turn 39:** prompt 89,340 tokens, no calls
- **Turn 41:** prompt 90,170 tokens, one call, id `duplicate_call_44`, 1,463 chars of arguments

The turn-38 call was a single `edit` whose `oldText` is 25,448 chars and `newText` is 25,802 chars — it re-emitted a roughly 25k-character block to change roughly 354 characters. The request took 179.3 seconds. It was rejected as a duplicate. Prompt tokens went 76,207 to 89,340 (+13,133) and never came back down: turn 39 was 89,340, turn 69 was 100,646. Those 13,133 tokens of a rejected, zero-information payload were re-sent on all 32 remaining turns.

## 4. The Compounding Effect

`contextOverflowPolicy` for this run is `fail`, not `compact` (field `turn_preflight_budget.contextOverflowPolicy`), so nothing ever reclaims the dead payload. Pushing the prompt from 76k to 89k moved the run into the context range where the VRAM-starved GPU degraded: RTX 4090, 23,776 MiB of 24,564 MiB held by the TabbyAPI process alone; two requests collapsed to Generate 16.5 T/s against a 55-95 T/s baseline, with prefill collapsing in lockstep to 6.57 T/s against a 240-1800 T/s baseline, then recovered — a VRAM-headroom signature, not a cache miss; prompt cache reuse was 97-99 percent on every turn. So the duplicate did not just waste 179 seconds once — it raised the floor cost of every later turn.

## 5. The Follow-On Symptoms

Turn 39 produced an empty `messages` array (zero output, prompt unchanged) and cost another 194.8 seconds. Turn 41 repeated the pattern as `duplicate_call_44`. Turns 59 and 60 logged `turn_zero_output_countdown` with `zeroOutputStreak` 1 and 2. The rejection text gives the model no signal that the problem is the *shape* of the call (a whole-block rewrite), only that it was a repeat.

## 6. The Fix (Task 4)

The rejected call arguments never need to reach the transcript. `rejectAsDuplicate` does not write an assistant message — it pushes a `ToolBatchOutcome` whose `action` is built by `buildEffectiveTranscriptAction` ([tool-action-processor.ts:483-492](src/repo-search/engine/tool-action-processor.ts#L483-L492)), and the assistant message is only assembled later by `appendToolBatchExchange`. Eliding at construction keeps the payload out entirely. This would have reclaimed roughly 13,100 tokens at turn 38 and kept the run under 90k.

## 7. Why the Messages Are Elided and Not Deleted

Four constraints rule out dropping the assistant/tool pair:

a) `appendToolBatchExchange` ([tool-call-messages.ts:72-84](src/tool-call-messages.ts#L72-L84)) folds ALL of a turn's outcomes into one assistant message, so a batch can mix accepted calls with a duplicate; deleting the message would take the accepted calls with it.

b) Every message with `role: "tool"` requires a matching `tool_calls[].id` on a preceding assistant message; removing the entry orphans it.

c) The rejection tool message is the only in-transcript signal that a repeat occurred. Removing it re-arms the exact loop the guard exists to break.

d) `DuplicateTracker.replayToolMessageIndex` ([duplicate-tracker.ts:46-56](src/repo-search/engine/duplicate-tracker.ts#L46-L56)) and `forcedFinishCountdownUserMessageIndex` are absolute indexes; `TranscriptManager` only bumps `generation` on `replaceWith` ([transcript-manager.ts:55-59](src/repo-search/engine/transcript-manager.ts#L55-L59)), so a mid-array splice would silently invalidate them.