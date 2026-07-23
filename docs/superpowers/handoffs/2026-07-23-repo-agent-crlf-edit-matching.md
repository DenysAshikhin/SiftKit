# Handoff: Fix repo-agent CRLF edit-matching hell

**Date:** 2026-07-23
**Context:** Surfaced while dogfooding `repo-agent` (approval mode) to implement the LLM auto-approval plan. Task 1 succeeded but burned ~10 of 38 turns fighting line endings, and produced a commit with 1544 changed lines for a 32-line addition (since fixed by hand via `git add --renormalize`-style LF restage + amend).

---

## Root cause (confirmed in code)

An **asymmetry between the `read` and `edit` native tools** in `src/repo-search/engine/repo-tools.ts`:

| Tool | Line | EOL handling |
| --- | --- | --- |
| `read` | [`repo-tools.ts:354`](../../../src/repo-search/engine/repo-tools.ts#L354) | `readTextFileWithEncoding(...).replace(/\r\n/gu, '\n')` — **normalizes CRLF → LF**. The model only ever sees LF. |
| `edit` | [`repo-tools.ts:644`](../../../src/repo-search/engine/repo-tools.ts#L644) | `const originalText = readTextFileWithEncoding(...)` — **raw bytes, no normalization**. |
| `edit` match | [`repo-tools.ts:609`](../../../src/repo-search/engine/repo-tools.ts#L609) | `originalText.indexOf(oldText)` — byte-exact. |

On Windows with `core.autocrlf=true` and **no `.gitattributes`** (this repo's exact state), the working tree is checked out CRLF while blobs are LF. The model reads a file (sees LF), constructs a multi-line `oldText` with `\n`, and `edit` tries to `indexOf` it in a CRLF `originalText` — guaranteed miss → `oldText not found in file`. The agent then thrashes: re-reads, inspects endings, even shells out to PowerShell to visualise `\r`, and retries. Single-line `oldText` (no embedded `\n`) matches fine, which is why some edits landed on the first try and others took four attempts.

### Secondary effect: mixed-EOL writes
When an edit *does* apply, `executeEdit` splices `originalText.slice(...) + newText` ([`repo-tools.ts:652`](../../../src/repo-search/engine/repo-tools.ts#L652)) and `writeFileSync(..., updatedText, 'utf8')` ([`:656`](../../../src/repo-search/engine/repo-tools.ts#L656)). `originalText` is CRLF, the model's `newText` is LF → the file becomes **mixed CRLF/LF**. `git add` (autocrlf=true) then stores the CRLF-dominant blob instead of normalising, so the committed diff explodes (every line reads as changed against the LF parent).

---

## The fix

One change closes both the matching failure and the mixed-EOL write. In `executeEdit`:

```ts
// repo-tools.ts, executeEdit (~line 644)
const originalText = readTextFileWithEncoding(resolvedPath.absolutePath).replace(/\r\n/gu, '\n');
// ...resolveEdits + splice unchanged (newText is already LF)...
writeFileSync(resolvedPath.absolutePath, updatedText, 'utf8'); // now uniformly LF
```

Matching `read` exactly (normalize on read-for-edit) makes multi-line `oldText` match, and writing the spliced LF text back keeps the file EOL-consistent so `git add` stores a clean LF blob.

**Defense in depth — add `.gitattributes` at repo root:**

```
* text=auto eol=lf
```

This makes the repo's EOL deterministic regardless of any tool's behavior or a contributor's `core.autocrlf`. The working tree stays LF, so the read/edit asymmetry can't reappear from a different angle. Without it, the fix above works but relies on autocrlf staying `true`.

### Tests to add (TDD)
- `edit` with a multi-line `oldText` against a CRLF-on-disk file → applies, result is pure LF. (Today: `oldText not found`.)
- `edit` a single region of a CRLF file → whole-file blob is pure LF afterward (no mixed endings).
- Keep an LF-file edit test as the regression guard.

Consider hoisting the `.replace(/\r\n/gu, '\n')` into `readTextFileWithEncoding` itself (or a `readSourceText` helper) so `read`, `edit`, and any future consumer share one normalization point instead of each remembering to call it — the current duplication is exactly how the asymmetry crept in.

---

## Does this also fix the other two Task-1 problems?

**1. "Workaround polluted the commit" — YES, fixed by the same change.** The 1544-line diff was a direct consequence of mixed-EOL writes (secondary effect above). Normalizing on read-for-edit + writing LF yields a targeted, pure-LF splice, so `git add` stores a clean `+N` blob. The `.gitattributes` guarantees it. No separate work needed.

**2. "Ragged ending" (`invalid_response_limit` after commit) — NO, unrelated.** After the commit succeeded, the agent did not emit a `finish` action; it kept issuing "post-commit verification" tool calls, produced 3 malformed actions in a row, and was killed by the invalid-response guard. That is an agent-behavior / prompt problem — the loop has no "task complete → finish" recognition once the terminal goal (the commit) is done. The CRLF fix only helps *indirectly* (fewer wasted turns, less polluted context), but the malformed-actions-after-completion behavior is independent and needs its own fix:
   - Give the agent an explicit completion checkpoint (e.g. a successful commit is a natural place to prompt for `finish`), and/or
   - Strengthen the system prompt so that once the plan's acceptance criteria are met the next action must be `finish`, and/or
   - Treat repeated invalid actions immediately after a successful terminal command as an implicit finish rather than a hard failure.

---

## Status of the triggering commit
Task 1's commit was repaired by restaging `planner-protocol.ts` as LF and amending. All four blobs are now pure LF (`CR=0`), diff is `4 files changed, 96 insertions(+), 1 deletion(-)`. The underlying tool bug is unfixed — this handoff is the fix.
