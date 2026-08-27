# Live Stream Drift Fixes Design

## Scope

Replace the seven drift points in the live narration/tool-activity implementation without compatibility paths.

## Design

- The Markdown/tool parser projects accumulated text on every update. Incomplete Markdown code stays undecided; completed code can recover to narration. Native tool-control state is explicit and never inferred from a prior textual projection.
- Every planner/provider response carries `rawText`, safe `narrationText`, and `classification`. Action parsing reads `rawText`; UI callbacks read the safe projection. Mock and network responses use the same normalization helper.
- Shared contracts distinguish persisted messages from live dashboard messages. `assistant_narration` is live-only, while sessions contain persisted messages only.
- A live assistant turn owns the activity-ring shell until an answer starts, even before the first command. The ring retains the last three command-derived rows.
- Tool progress uses an explicit tool-call limit carried by progress events and persisted tool messages. The engine enforces that limit so the denominator is truthful.
- State and scorecard types are inferred from runtime schemas; duplicated handwritten structures are removed.
- The existing accidental commit is not rewritten in this implementation because history rewriting is destructive and needs explicit approval. All corrective changes remain uncommitted.

## Acceptance criteria

- Incomplete fenced/inline Markdown never leaks or permanently latches tool control; completed quoted markup streams as narration.
- Raw tool markup is available only to action parsing, never as ordinary streamed/persisted answer text.
- Persisted session parsing rejects `assistant_narration`; live message parsing accepts it.
- The empty ring is visible during a live assistant turn and disappears when the answer begins.
- Ring progress is tool calls divided by an enforced tool-call limit.
- Relevant tests, full tests, typecheck, lint, and build pass.
