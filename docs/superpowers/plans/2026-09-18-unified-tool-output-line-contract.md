# Unified tool-output line contract (no silent omissions)

> **Status: CONFIRMED — plan only, no fixes applied.**
> **Date:** 2026-09-18
> **Scope:** repo-agent tools (`read`, `grep`, `find`, `ls`, `git`, `run`, `edit`, `write`) and the summary planner's `read_lines`/`find_text`.
> **Authoritative invariant:** *a model must never be able to infer a wrong total from a tool result.* Every omission must be named in the result, counted in the same units the model counts in, and paired with the exact next call that recovers it.

---

## 1. The original claim, confirmed

The reasoning under review said:

> `chat-run-recovery.test.ts` has 189 lines by `Measure-Object -Line` but I read 195 lines… `Measure-Object -Line` counts lines within each string — for empty strings it counts 0. So it undercounts blank lines. Fine, the file is ~195 lines.

**Confirmed on two counts.**

(a) The PowerShell mechanism is exactly as diagnosed. `Get-Content` emits one string per line; `Measure-Object -Line` counts *lines within each input string*, so an empty string contributes **0**. Blank lines are invisible to it.

(b) The arithmetic signature reproduces on a live file today. `tests/chat-run-recovery.test.ts`:

| Counter | Result |
|---|---|
| `read` tool (and `(Get-Content).Count`) | **262** |
| `Get-Content \| Measure-Object -Line` | **253** |
| delta | **9** |
| blank-only lines in the file | **9** |

Delta == blank-line count exactly. Same as the quoted 195 − 189 = 6. The model was right that the file is longer than `Measure-Object` claimed; it had no way to know *by how much*, and neither `read` nor `run` told it.

**But the diagnosis is incomplete.** `Measure-Object -Line` is only the most visible symptom. The repository has **five different definitions of "how many lines"** and **at least seven independent omission paths**, several of which under-report inside SiftKit's own tools — including one where a whole-file `read` returns 10 lines and says nothing more. That is the actual "read undercounts to save tokens" the task asks about, and it is worse than the PowerShell quirk because the model has no way to suspect it.

---

## 2. Measured defect inventory

All items below were reproduced by driving the real functions (`planRead`, `buildReadExecution`, `findContiguousUnreadRange`, `ToolOutputFitter`, `countExtractedLines`) via `npx tsx`, not inferred.

### 2.1 Five answers for one file

File on disk: `alpha\n\ngamma\n\n\nzeta\n` (6 lines).

| Source | Answer | Wrong by |
|---|---|---|
| `read` / `splitSourceLines` (`repo-tools.ts:430`) | **6** | correct |
| `(Get-Content).Count` | **6** | correct |
| `Get-Content \| Measure-Object -Line` | **3** | −3 (blanks) |
| `Select-String -Pattern '.'` | **3** | −3 (blanks) |
| `[IO.File]::ReadAllText() -split "\n"` | **7** | +1 (phantom trailing) |
| `countExtractedLines` (`line-read-guidance.ts:113`) | **7** | +1 (phantom trailing) |

`countExtractedLines` is **SiftKit's own** helper. It feeds `avgTokensPerLine` → `recommendedLines` (`line-read-guidance.ts:153-179`), so the "recommended window size" advice handed to the model is derived from a line count that disagrees with the line numbers `read` prints.

### 2.2 `read` silently over-returns past an explicit `limit` ← *new, not in the original diagnosis*

`planRead` (`repo-tools.ts:491-503`) computes `requestedEndExclusive` from `limit`, then passes `totalEnd = expandReads && hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive`. Once *any* range has been returned for that file, `ExpandReads` (default **true**, `config/defaults.ts:148`) discards the caller's `limit` and runs to EOF.

Measured — 60-line file, after a prior read of lines 1-10:

```
args={"offset":21,"limit":10}  requested=21..30  ->  returned 21..60  (40 lines)
```

The model asked for 10 lines and got 40. Nothing in the output says so. The tool description (`planner-protocol.ts:52`) and the system prompt (`prompts.ts:310-313`) never mention that `limit` is advisory once a file has been touched. `limit` documented as a cap is not a cap.

### 2.3 `read` silently under-returns a whole-file request ← *the primary cause of the confusion*

`findContiguousUnreadRange` (`tool-output-fit.ts:131-167`) returns **one contiguous** unread run: it advances `start` past covering ranges, then stops at the first returned range that begins after `start` (`:161-162`). Everything after that gap is dropped from the call — with no trailer, no "more unread below", and no mention of the file's total length.

Measured — 60-line file, read 1-10 then 21-30, then a bare whole-file `read`:

```
A3 args={}  requested=1..60  ->  returned 11..20  (10 lines)   [no notice]
A4 args={}  requested=1..60  ->  "Lines 1-60 ... were already returned in this run."
A5 args={"offset":31}        ->  "Lines 31-60 ... were already returned in this run."
```

A3 is the bug in its purest form: the model requests the whole file, receives ten lines ending at line 20, and gets **zero signal** that the file continues. The natural inference — "the file ends near line 20" — is wrong, and it is the exact failure mode described in the task ("read undercounts… confuses the llm's"). `buildReadExecution` (`repo-tools.ts:560`) emits only the numbered block; `totalEndLineExclusive` is computed at `:489` and **never surfaced to the model on a successful read**.

### 2.4 The "already returned" message asserts content the model never saw

A4/A5 above claim lines 1-60 / 31-60 "were already returned in this run". The model has no memory of a 31-60 window in a whole-file read (it only exists because A2 over-returned, §2.2). The message is defensible from the engine's side and reads as a gaslight from the model's side. It also routes through `screenExhaustedRead` (`tool-action-processor.ts:957-963`) as a *rejection*, so the model is told it did something wrong for asking again. This is the mechanism the original reasoning hit when it couldn't reconcile counts.

### 2.5 Blank lines are dropped from every non-`read` output path

- `tool-result-budgeter.ts:85` — `resultText.split(/\r\n/).filter((line) => line.length > 0)` before fitting.
- `summary/planner/mode.ts:1184` — identical filter.
- `repo-tools.ts:663` — `matchLines = … .filter(Boolean)` on `rg` stdout.

Measured: 9 real lines → 5 segments fed to the fitter. For `run`, `git diff`/`show`, and planner output, **blank lines vanish from what the model sees**. Consequences:

1. A model that reads a file with `read` (blanks present, numbered) and then inspects the same region via `git show`/`git diff`/`run` sees a *different line count* for identical content, and any `run`-derived line number is shifted by the number of blanks above it.
2. It then composes `edit.oldText` from the wrong view. `resolveEdits` (`repo-tools.ts:783-803`) does exact `indexOf` on LF-normalized text, so a missing/extra blank line means `oldText not found` or, worse, matches a different site.
3. `truncatedLineCount` (`tool-output-fit.ts:74-80`) counts *segments*, so the notice under-reports. Measured: 9 real lines in → `"5 lines truncated due to per-tool context limit."`

`read` itself is accidentally immune to the blank-drop only because every rendered line carries an `N: ` prefix and is therefore never empty — an accident of formatting, not a guarantee.

### 2.6 `git` truncates silently, and its caps are inconsistent with every other tool

`capOutputLines` (`read-only-git-tool.ts:160-166`) does `slice(0, limit)` and **appends no notice at all**, unlike `grep`/`find`/`ls`, which all append `... N more … beyond limit=N` (`repo-tools.ts:635`, `:707`, `:744`).

| Tool / operation | Default cap | Over-cap notice |
|---|---|---|
| `grep` | 100 (`GREP_DEFAULT_LIMIT`) | yes |
| `find` | 1000 | yes |
| `ls` | 500 | yes |
| `git log` | 20 (`DEFAULT_LOG_LIMIT:12`) | **no** |
| `git grep` | **none** (`outputLimit` only if `limit` passed, `:142`) | **no** |
| `git ls_files` | **none** (`:147`) | **no** |
| `git show` / `diff` / `blame` | **none** | only the generic token fitter |
| `read` | 2 MB byte cap (`READ_MAX_BYTES`) | n/a |

Four defaulting policies and two notice policies. `git grep` also caps *twice* — `git grep -m N` (which is per-**file** in git, not global) and then `capOutputLines` globally — so `limit` means something different than it does in `grep`. The `git` schema description (`planner-protocol.ts:125-129`) mentions no caps or defaults at all, while `grep`/`find`/`ls` descriptions do (`:97`, `:102`, `:107`).

### 2.7 `ExpandReads` means two different things depending on the code path

Same config flag, same `findContiguousUnreadRange`, opposite semantics:

- `repo-tools.ts:495-501` — comment: *"Both modes skip lines already returned"*; the flag only widens the end bound.
- `summary/planner/mode.ts:316` — `returnedRanges: input.expandReads ? input.returnedRanges : []`; when disabled, **nothing is skipped at all**.

Measured: with `expandReads=false`, repo-search rejects a re-read of lines 1-10 as "already returned", while the planner hands back `1..11` verbatim. `dashboard/src/settings-sections.ts:50` documents a third behaviour ("repeated narrow file reads can be expanded"), matching neither.

### 2.8 Minor rendering inconsistencies

- `buildReadExecution` (`repo-tools.ts:560`) and `buildGrepArgs`/`.trim()` on `noUnreadOutput` (`:542`) trim the whole block. Measured: a mid-window blank line renders `"2: "` (trailing space), a **final** blank line renders `"3:"` (trimmed). Same content, position-dependent rendering — and the trailing space is the exact string a model reproduces wrongly into `edit.oldText`.
- `edit`/`write` report only bytes / edit counts (`repo-tools.ts:775`, `:837`). After a mutation the model knows nothing about the new line count, so its next `read` starts from a stale mental model. `read`-state invalidation is correct (`tool-action-processor.ts:1329-1336`), but the *count* is not returned.
- Image reads take `offset`/`limit` parameters that do not apply (`planner-protocol.ts:52-58`), i.e. accepted-and-ignored args.
- `countExtractedLines`'s +1 (§2.1) and `isLineBoundGetContentCommand` (`line-read-guidance.ts:120-132`), which sniffs `Get-Content | Select-Object -First/-Last` command *text* to synthesize line-read stats, are a shell-shaped special case inside a structured-tool engine.

### 2.9 The metrics are blind to all of this

After the §2.3 sequence the overlap summary reads:

```json
{"pathKey":".tmp/linecheck/a.txt","totalLinesRead":60,"uniqueLinesRead":60,"overlapLines":0,"overlapRatePct":0}
```

0% overlap, 60/60 unique — looks perfect. The engine's telemetry cannot see the confusion because it tracks *ranges handed to the model*, not *whether the model understood where it was*. Any post-fix validation must not rely on `overlapRatePct` alone.

### 2.10 The good precedent already in the codebase

`validation-command-output-policy.ts:61-85` is the pattern to standardise on. It emits a leading total (`"N lines omitted from validation command output."`) **and** per-gap markers (`"… N lines omitted …"`, `:78`), and `RUN_FULL_DOWNGRADE_NOTICE` (`:158-160`) announces a mode downgrade with the exact recovery action. `summary/planner/formatters.ts:24-31` already emits a frame header (`read_lines startLine=… endLine=… lineCount=…`). Both exist; neither is applied to repo-agent `read`/`git`.

---

## 3. Target contract (the unification)

One rule set, every tool, no exceptions.

- **I1 — Explicit means exact.** An explicitly supplied `limit`/`offset` window is honoured exactly (clamped only at EOF). It is never widened (§2.2) and never narrowed without a trailer.
- **I2 — No silent short delivery.** If a call does not deliver everything it was asked for, the result ends with a trailer naming the undelivered ranges **and the exact next call**. Applies to `read`, `grep`, `find`, `ls`, all `git` ops, and `run`.
- **I3 — Every result states its own frame.** A successful `read` always reports `path`, lines returned, **total file lines**, and remaining unread ranges. Same for `git diff`/`show` (total lines of the diff) and `run` (total output lines).
- **I4 — One line model.** A single exported `splitSourceLines`/`countLines` is the only definition of a line, used by `read`, `edit`, `write`, `countExtractedLines`, the fitter's segmenting, and every truncation counter. Blank lines are always counted, always rendered, and always counted in notices.
- **I5 — One notice vocabulary.** One sentence template, one position, real-line units, everywhere. Retire `capOutputLines`'s silence and the ad-hoc `... N more …` phrasings in favour of the §2.10 form.
- **I6 — Uniform cap defaults.** `grep`/`find`/`ls`/`git log`/`git grep`/`git ls_files` share one documented default-and-notice policy; `show`/`diff`/`blame` get the same treatment (bounded + announced, or explicitly unbounded).
- **I7 — One meaning per flag.** `ExpandReads` means one thing in both planners, or is deleted.
- **I8 — Same call ⇒ same result.** No tool rewrites its own output based on hidden cross-call state (§4).

---

## 4. Central design decision

The token-saving mechanism to fix is the **cross-call line dedupe** (`ReadWindowGovernor` + `findContiguousUnreadRange` + `screenExhaustedRead`). It is the only stateful, output-rewriting tool in the set; `grep`/`find`/`ls`/`git`/`run` are all stateless. That asymmetry is the root of §2.2-2.4 and I8.

### Option A — **recommended**: make `read` stateless; delete the dedupe

`read` returns exactly the requested window (all of it, every time). Remove `findContiguousUnreadRange`'s use in `planRead`, `noUnreadOutput`, `screenExhaustedRead`'s exhausted-read rejection, and `expandReads` end-to-end. Keep `ReadWindowGovernor`'s *counters* for observability only (they already survive `invalidatePath`), fed by the returned window, with zero influence on output.

Thrash protection is not lost: the independent `DuplicateTracker` / semantic-repeat rejection (`tool-loop-governor.ts`, `prompts.ts:295`) already rejects verbatim repeat calls **as an explicit, named rejection** — which is the honest version of what the dedupe does silently today. Token control remains with the token fitter, which already announces.

*Why preferred:* it is the smallest complete change that satisfies I1-I8 simultaneously; it deletes rather than patches (AGENTS.md: *"Refactors must be complete replacements. Remove obsolete artifacts. No compatibility, shims, fallbacks, or parallel paths"*); and it makes `read` behave like every other tool the model already trusts.

### Option B — keep the dedupe, disclose it completely

Multi-range reads (deliver *all* unread lines in the window, not one contiguous run), never widen past an explicit `limit`, and a mandatory trailer + frame (§3 I2/I3). Strictly more machinery and more states to test than A, and it keeps a flag whose two current meanings must still be reconciled. Choose B only if measured token spend without dedupe is unacceptable.

**Decision gate:** run Phase 0 below, then pick. Everything in Phases 1-5 is required under either option.

---

## 5. Implementation plan (TDD; each phase lands green)

### Phase 0 — Baseline measurement (no product change)
- [ ] Add a throwaway harness (mirroring the recipes in §9) that, for a fixed fixture file, prints: file line count, `read` window returned, notices emitted, and tokens per turn.
- [ ] Capture the §2.3 sequence end-to-end through the real loop (`tests/mock-repo-search-loop.test.ts` scaffolding) as a **characterisation test** asserting today's confusing output, to be deliberately inverted in Phase 2.
- [ ] Record `overlapRatePct` vs. model-visible coverage for a few real runs (§2.9) so post-fix comparison is possible.

### Phase 1 — One line model (I4)
- [ ] Promote `splitSourceLines` (`repo-tools.ts:430-434`) to `src/lib/text-encoding.ts` beside `readSourceText`, next to a single `countSourceLines(text)` with the same trailing-newline rule.
- [ ] Re-point to it: `countExtractedLines` (`line-read-guidance.ts:113-118`), `tool-result-budgeter.ts:85`, `summary/planner/mode.ts:1184`, `repo-tools.ts:663`, `read-only-git-tool.ts:160-166`, `validation-command-output-policy.ts:61-64`.
- [ ] **Delete** the `.filter((line) => line.length > 0)` / `.filter(Boolean)` blank-line drops; the fitter segments on real lines. Notices now count real lines (§2.5).
- [ ] Remove `isLineBoundGetContentCommand`'s command-text sniffing (`line-read-guidance.ts:120-151`) in favour of stats from actual structured reads; let `getRepoSearchLineReadStats` handle only genuine `run` cases with the shared counter.
- [ ] Make blank-line rendering position-independent: stop `.trim()`ing whole blocks (`repo-tools.ts:542`, `:560`); render a blank line as a fixed form (pick `N:` with no trailing space, or `N:·`) and use it in every position.
- [ ] Tests: fixture with leading / interior / trailing blanks, LF and CRLF, no-trailing-newline; assert one count everywhere and identical rendering per position.

### Phase 2 — Exact, fully-disclosed `read` (I1, I2, I3, I8)
- [ ] Per the Phase 0 decision: **A** — strip dedupe from `planRead` (`:494-503`), drop `noUnreadOutput` (`:517-519`), `screenExhaustedRead` (`tool-action-processor.ts:957-963`), `expandReads` (signature `:445`, context `:88`, call site `:883`), `findContiguousUnreadRange` (`tool-output-fit.ts:131-167`) and its planner twin `computeReadLinesRange` (`summary/planner/mode.ts:302-318`). **B** — multi-range delivery + never widen past `limit`.
- [ ] Emit a frame on every successful read, reusing the planner precedent (`formatters.ts:24-31`), e.g. `src/x.ts: returned lines 11-20 of 60 | unread remaining: 21-30, 41-60`, plus an explicit `end of file` when there is no remainder. This alone kills the §2.3 misreading.
- [ ] Surface the byte-cap rejection (`:471-477`) and the offset-past-end rejection (`:480-486`) with the same frame so both paths agree on the total.
- [ ] Make `edit`/`write` return the resulting line count (`:775`, `:837`) so the next read starts from a correct total.
- [ ] Make image reads reject `offset`/`limit` instead of ignoring them.
- [ ] Tests: the §2.3 sequence must now show a whole-file read delivering everything, or a disclosed remainder with the next call; `limit` never exceeded; every result carries the true total.

### Phase 3 — Uniform caps + notices for search and git (I2, I5, I6)
- [ ] One notice builder (shape from `validation-command-output-policy.ts:70-83`) used by `grep` (`:635`), `find` (`:707`), `ls` (`:744`), and all `git` ops.
- [ ] Replace `capOutputLines` (`read-only-git-tool.ts:160-166`) with the announcing capper; give `show`/`diff`/`blame` a declared bound; give `git grep`/`ls_files` the same default as their structured twins; make `git grep`'s cap global (drop the per-file `-m` double cap, `:138` + `:142`).
- [ ] Tests: every tool, over-cap and under-cap; assert the same sentence shape and a truthful count.

### Phase 4 — Token fitter consistency (I2, I4, I5)
- [ ] Notices count real lines; the `maxTokens * 0.5` target (`tool-output-fit.ts:58`) is stated in the notice so "why so little survived" is explainable.
- [ ] When nothing survives, keep the surviving-0 case honest and, for `read`, do not record the window (guard at `tool-action-processor.ts:1140-1159` already skips recording — pin it with a test).
- [ ] Keep `keep:'head'|'tail'` but state which end survived in the notice.

### Phase 5 — Config, schema, prompt, dashboard (I7)
- [ ] Option A: delete `ExpandReads` — `packages/contracts/src/config.ts:309`, `config/defaults.ts:148`, `config/getters.ts:129-131`, `status-server/config-store.ts:129,162`, `status-server/routes/server-admin.ts:51`, `dashboard/src/settings-draft-editor.ts:33`, `dashboard/src/settings-sections.ts:50`, `dashboard/src/tabs/SettingsTab.tsx:144-151`, plus the SQLite column/migration. Option B: one shared helper both planners call, and fix `mode.ts:316`.
- [ ] Rewrite the model-facing text to match reality: `planner-protocol.ts:52` (`TEXT_ONLY_READ_DESCRIPTION`), `:97`, `:102`, `:107`, `:122` (`run`), `:125-129` (`git` — state caps/defaults), and `prompts.ts:310`, `:313`, `:318`, `:359-361`.
- [ ] Add one prompt line: file length comes from `read`'s frame only; `Measure-Object -Line` and `Select-String` count non-blank lines — use `(Get-Content).Count`. This is the lesson the original reasoning had to derive by hand.

---

## 6. Files to touch

**Core:** `src/lib/text-encoding.ts`, `src/repo-search/engine/repo-tools.ts`, `src/tool-output-fit.ts`, `src/repo-search/engine/tool-result-budgeter.ts`, `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/engine/read-window-governor.ts`, `src/repo-search/engine/read-overlap.ts`, `src/repo-search/engine/read-only-git-tool.ts`, `src/repo-search/engine/validation-command-output-policy.ts`, `src/line-read-guidance.ts`, `src/summary/planner/mode.ts`, `src/summary/planner/formatters.ts`.

**Interface:** `src/repo-search/planner-protocol.ts`, `src/repo-search/prompts.ts`, `src/repo-search/repo-tool-arguments.ts`.

**Config/UI (Option A only):** `packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/getters.ts`, `src/state/runtime-db.ts`, `src/status-server/config-store.ts`, `src/status-server/routes/server-admin.ts`, `dashboard/src/settings-draft-editor.ts`, `dashboard/src/settings-sections.ts`, `dashboard/src/tabs/SettingsTab.tsx`.

## 7. Tests to migrate (these pin today's behaviour and will go RED)

| File | Anchors | Why |
|---|---|---|
| `tests/repo-tools.test.ts` | `:273-296`, `:340-351`, `:385-395` | `noUnreadOutput` wording; grep notice phrasing |
| `tests/mock-repo-search-loop.test.ts` | `:455-457`, `:610-612`, `:705-712`, `:1139-1141` | exhausted-read rejection; truncation notices |
| `tests/repo-search.test.ts` | `:576-579` | truncation notice on a read |
| `tests/engine-tool-result-budgeter.test.ts` | `:63-65`, `:83-87`, `:111-113` | notice counts (currently segment-based) |
| `tests/tool-output-fit.test.ts` | `:51-53` | `truncatedLineCount` semantics |
| `tests/runtime-planner-mode.test.ts` | `:1186-1189`, `:1286-1290` | planner header + notices |
| `tests/repo-search-status-server.test.ts` | `:1090-1092` | truncation notice |
| `tests/summary-read-lines-expansion.test.ts` | whole file | `ExpandReads` semantics (Option A deletes it) |
| `tests/engine-read-window-governor.test.ts` | dedupe-coupled cases | governor becomes observability-only |
| `tests/line-read-guidance.test.ts` | `countExtractedLines` +1 | shared counter changes values |
| `tests/read-only-git-tool.test.ts` | silent `capOutputLines` | notices added |
| `tests/config-normalization.test.ts` | `:366-380` | `ExpandReads` |
| `tests/presets.test.ts`, `tests/helpers/runtime-config.ts`, `dashboard/tests/fixtures.ts:112`, `dashboard/tests/settings-tab.test.tsx:91-97` | full-config literals | strict typed fixtures |

**New tests:** blank-line invariance (Phase 1); whole-file-read frame (Phase 2); `limit` never exceeded (Phase 2); per-tool over-cap notice matrix (Phase 3); surviving-0 recording guard (Phase 4); `Measure-Object -Line` vs `read` delta documented as a regression fixture (a file whose blank count equals a known delta, e.g. the 262/253/9 case).

**Verification:** `npm run typecheck && npm test`, plus `npm run test:dashboard` if the config surface changes.

## 8. Risks / open questions

- **Token spend.** Option A raises it on re-read-heavy runs. Mitigated by the existing duplicate rejection and the token fitter; measure in Phase 0 before committing to B.
- **Fitter blank-drop removal** slightly enlarges truncated outputs. Acceptable; it is the correctness fix.
- **Notice churn.** Many tests and prompt strings quote exact wording; land Phase 3's single builder *before* rewriting notices so there is one string to update.
- **`git grep -m` semantics** change from per-file to global — intentional, but call it out in the commit message.
- **Out of scope:** the `tool-loop-governor` stagnation heuristics, the `README.md`/`ARCHITECTURE-REVIEW.md` prose, and the unrelated `exllamav3-pr341-implementation-plan.md`. Only the tool-output line contract is in scope.

## 9. Appendix — reproduction recipes

Drive the real code with `npx tsx .tmp/<name>.mts` (use `.mts` — top-level `await` fails under the repo's CJS default).

```ts
import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import { planRead, buildReadExecution, isFailedReadPlan } from '../src/repo-search/engine/repo-tools.js';
import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';

const windows = new ReadWindowGovernor();
const policy = buildIgnorePolicy(process.cwd());
// 60-line fixture at .tmp/linecheck/a.txt, then: read 1-10, read 21-30, read all.
const plan = planRead({ path: '.tmp/linecheck/a.txt' }, process.cwd(), policy, windows.stateMap, true);
// -> effectiveStartLine=11, effectiveEndLineExclusive=21, totalEndLineExclusive=61, hasUnread=true
// -> buildReadExecution('read', plan).output is 10 lines with NO trailer.  §2.3
```

Blank-line / EOL divergence, one 6-line file `alpha\n\ngamma\n\n\nzeta\n`:

```
read → 6 | (Get-Content).Count → 6 | Measure-Object -Line → 3 | Select-String '.' → 3
ReadAllText -split "`n" → 7 | countExtractedLines → 7
```

Live file confirming the original claim:

```powershell
$f = 'tests\chat-run-recovery.test.ts'
(Get-Content $f).Count                      # 262  (== read)
(Get-Content $f | Measure-Object -Line).Lines   # 253
((Get-Content $f) | Where-Object { $_ -eq '' }).Count   # 9   == 262 - 253
```