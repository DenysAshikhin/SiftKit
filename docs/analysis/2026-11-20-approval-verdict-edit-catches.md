# Approval-verdict edit checks: what they catch, by model (2026-11-20)

## Pending decision

If 27B workers keep never having an edit stopped by their own approval check, turn thinking off for the
worker's self-review (approval verdict), but keep thinking on for the orchestrator's review. Gather more
27B samples first; re-run the counts below before deciding.

## Future preset settings

- A `self-review` section in the repo-agent preset settings: a thinking on/off toggle for the action approval
  verdict and a custom thinking limit (today fixed at 1,024 reasoning tokens).
- Presets show their id alongside the name in the settings UI, and the id is editable.

## How the check works

- Every worker `edit`/`write`/`run` call gets an isolated verdict request on the **worker's own model**
  (`src/repo-search/engine/task-loop.ts`, `requestApprovalVerdict`). It sees the approver prompt, tool
  definitions and the proposed call only, never the transcript or the target file.
- `unsure` escalates to the orchestrator (Flash-Next in the comparison runs); `deny` rejects.
- Thinking follows the worker's setting, capped at 1,024 reasoning + 512 answer tokens
  (`src/repo-search/planner-protocol.ts:641-652`).

## Counts (all real repo-agent runs in `.siftkit/runtime.sqlite`, as of run 60dc585d)

| worker / checker | edit+write checks | approve | unsure | deny | edits actually stopped |
| --- | --- | --- | --- | --- | --- |
| 27B | 43 | 43 | 0 | 0 | 0 |
| Flash-Next | 586 | 516 | 63 | 7 | 12 (7 deny + 5 unsure rejected by orchestrator) |

Flash-Next's 12 stopped edits: 5 weakened tests (deleted assertions/scaffolding; nothing downstream
catches these), 3 invalid TypeScript or missing symbols (typecheck would catch), 1 edit clearing the env
var a CLI test guard relies on, 3 orchestrator rejections not yet inspected. The other 58 `unsure` were
mostly "cannot verify without the file" noise and were approved by the orchestrator.

## Cost of the check (27B, run 60dc585d workers 43ef8d97 + 416e2289)

- 70 verdicts, 295 s total, mean 4.2 s, p90 7.4 s; 64% decode (~270 tokens at ~105 tok/s), 36% prefill
  and request overhead (~1.5 s each).
- Thinking per verdict: median 188, p90 497, max 591 tokens. Lowering the budget barely helps: 512 →
  296 s, 384 → 287 s, 256 → 266 s (36% of verdicts truncated).

## Alternatives noted

- Auto-approve edits inside the task's write paths (skips ~4 s per edit check).
- Keep the check only for edits that delete lines from test files (the category that matters).
