# Run-command corpus: orchestrator run 67e089d0

Every test, typecheck, and lint `run` result the workers of orchestrator run `67e089d0-80ed-4e02-a9f0-c73614341c13` received (2026-11-03, 181 results). `tests/output-digest-corpus.test.ts` checks each file's exact digest against `expected.json`, plus invariants that do not depend on it.

- **Text is what the model saw**, not the raw tool output: the run logs keep only the shown result. SiftKit's own notices inside it (`N lines truncated due to per-tool context limit.`, `N lines omitted from validation command output.`, `timeout=…ms exceeded; command was killed`) are kept. A digest over a tail can only reflect what the tail holds.
- **The leading digest SiftKit added is removed.** `index.json` records how: `exact` (the remaining text re-digests to the removed block), `structural` (the block's own line forms; a cut digest's trailing notice goes with it), or `none` (no digest was shown).
- **Names:** `<task>-t<turn>.txt`, with `f<attempt>` after the task for a fix attempt (`t10f1-t43.txt`).
- `index.json` also records the command, exit code, whether the worker piped the output (`class`: `unfiltered`, `partial` for `Select-Object -Last/-First` or `Get-Content -Tail`, `filtered` for `Select-String`/`Where-Object`), and the tool it ran.

`expected.json` was generated from the parsers as of 2026-11-03 and reviewed: every `FAILED` digest is backed by a failing line in its file. Regenerate it only for an intended parser change, and review the diff.
