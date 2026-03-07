# Distill + Codex Recommendation

## Purpose

This document consolidates the full recommendation for using [`distill`](https://github.com/samuelfaj/distill) with Codex, including:

- what `distill` is doing
- when it is useful vs risky
- the recommended `AGENTS.md` policy
- the model `distill` recommends and how good that model is for this task
- a practical evaluation plan to test whether the compression is good enough in a real workflow

---

# 1) Overall Assessment

## What `distill` is

`distill` is a local shell-output compressor. It sits in a pipeline and turns large, noisy command output into a smaller answer targeted to a narrow question.

Typical examples:

- test output
- lint floods
- long `rg` / grep results
- `git diff` summaries
- `terraform plan` summaries
- `npm audit` summaries

Example usage:

```bash
bun test 2>&1 | tee /tmp/test.log | distill "did tests pass? if not, list only failing test names"
```

## My view

The idea is good.

For **high-volume, low-information output**, this is a smart optimization. It can reduce the number of tokens sent to the main model dramatically when the raw output is mostly repetition, boilerplate, or noise.

The problem is that this is **lossy compression**. It is not free. Once a smaller model summarizes raw stderr/stdout before a larger model sees it, a new failure mode is introduced:

- the summary can omit the one decisive line
- it can mis-rank what matters
- it can paraphrase too aggressively
- it can sound correct while being incomplete

So the correct framing is:

> `distill` is a useful optimization for noisy command output.
> It is not a universal replacement for raw logs.

---

# 2) Where `distill` Works Well vs Poorly

## Good use cases

Use `distill` for bulky, repetitive, mostly informational output such as:

- pass/fail test summaries
- unique lint error extraction
- search result compression
- repeated log deduplication
- high-level diff summaries
- package audit extraction
- quick infra summaries when the goal is extraction, not judgment

Examples:

```bash
npm run lint 2>&1 | tee /tmp/lint.log | distill "list unique lint errors by file and rule; omit duplicates"
```

```bash
git diff HEAD~1..HEAD | tee /tmp/diff.log | distill "summarize the functional changes by file in 5 bullets max"
```

```bash
npm audit --json | tee /tmp/audit.json | distill "extract critical and high vulnerabilities as JSON with package, severity, and fix version"
```

## Poor / risky use cases

Do **not** trust `distill` as the primary view for:

- flaky test debugging
- build/install failures
- runtime crashes
- stack traces during root-cause analysis
- auth/network/TLS failures
- migrations or destructive operations
- infra safety/risk judgments
- security decisions
- any case where exact stderr wording matters
- any case where ordering/timing matters

In those cases, the correct default is:

1. inspect raw output first
2. summarize afterward only if helpful

---

# 3) Recommended Operating Principle

## Best practice

Use `distill` as a **cheap first-pass compressor**, not as a truth engine.

Treat it as:

- **good at extraction/compression**
- **decent at grouping and deduping**
- **not reliable enough for safety/risk/root-cause judgment on its own**

## Preferred pattern

Always preserve raw output when the full text might matter:

```bash
<command> 2>&1 | tee /tmp/cmd.log | distill "<narrow question>"
```

That gives you the small summary first, while retaining a reversible path to the raw log.

## Even better: reduce verbosity before involving any model

Prefer deterministic filtering first whenever possible:

- `--quiet`
- `--summary`
- `--stat`
- `--compact`
- JSON / YAML output modes
- `rg`
- `grep`
- `jq`
- `tail`
- `awk`
- `sed`

A good shell filter is often safer than model summarization because it cannot hallucinate.

---

# 4) Recommended `AGENTS.md`

Save this as `~/.codex/AGENTS.md` if you want Codex to use `distill` conservatively and safely.

```md
# Default shell-output handling

## Goal
Minimize token usage from large, noisy command output while preserving accuracy for debugging and risky operations.

## General rule
When running shell commands that may emit a lot of output, prefer to:
1. reduce verbosity at the source with native flags/tools;
2. use deterministic filtering when possible;
3. use `distill` only for high-volume informational output;
4. preserve access to raw output whenever the exact text may matter.

Do not blindly pipe every command through `distill`.

---

## Prefer native reduction first
Before using any model-based summarizer, prefer:
- quiet / concise flags
- machine-readable output (`json`, `yaml`, etc.)
- targeted filters like `rg`, `grep`, `jq`, `sed`, `awk`, `tail`
- summary modes like `--stat`, `--summary`, `--compact`

Examples:
- prefer `git diff --stat` before full diff if only a summary is needed
- prefer concise test reporters when acceptable
- prefer `terraform plan -no-color` and filter relevant sections
- prefer targeted `rg` searches over broad output dumps

---

## When to use distill
Use `distill` for commands with bulky, repetitive, mostly informational output, such as:
- test runs
- lint output
- `git diff` summaries
- search results
- package audit output
- infra plans for quick high-level summaries
- logs where the user asked for trends, counts, or a concise summary

When using `distill`, ask it a narrow question and keep the prompt task-specific.

Examples:
```bash
bun test 2>&1 | tee /tmp/test.log | distill "did tests pass? if not, list only failing test names and first error per failure"
npm run lint 2>&1 | tee /tmp/lint.log | distill "list unique lint errors by file and rule; omit repeated instances"
git diff HEAD~1..HEAD | tee /tmp/diff.log | distill "summarize the functional changes by file in 5 bullets max"
terraform plan -no-color 2>&1 | tee /tmp/tfplan.log | distill "summarize resources added, changed, and destroyed; highlight any destructive actions"
npm audit --json | tee /tmp/audit.json | distill "summarize critical and high vulnerabilities, affected packages, and suggested upgrades"
```

---

## When NOT to use distill
Do not use `distill` as the primary view when:
- debugging build failures
- debugging runtime crashes
- diagnosing stack traces
- investigating auth, networking, TLS, or permissions issues
- working with migrations or destructive operations
- exact stderr wording matters
- output ordering/timing matters
- interactive / TUI programs are involved
- the user explicitly asks for raw output
- the output is already short

In these cases, inspect raw output directly first. Summarize afterward only as a secondary step.

Examples of commands that should usually stay raw first:
- `npm install`
- `pnpm install`
- `docker build`
- `docker compose up`
- `kubectl describe ...`
- `journalctl ...`
- `systemctl status ...`
- application stack traces
- migration logs
- compiler errors when root-causing a failure

---

## Preserve raw output
If there is any chance the full text may matter, preserve raw output with `tee` before summarizing.

Preferred pattern:
```bash
<command> 2>&1 | tee /tmp/cmd.log | distill "<narrow question>"
```

If the summary seems incomplete, inconsistent, or suspicious, immediately inspect the raw log instead of repeating the summarized command.

Examples:
```bash
tail -n 200 /tmp/cmd.log
rg -n "error|warning|failed|exception" /tmp/cmd.log
```

---

## Accuracy over compression
Never present `distill` output as if it were guaranteed complete. Treat it as a lossy summary.

If a task is safety-critical, destructive, or production-affecting:
- review the raw output;
- quote exact lines when relevant;
- do not rely only on summarized output.

This especially applies to:
- infra changes
- database changes
- deployment failures
- security findings
- permission or auth issues

---

## Decision rule
Use this heuristic:

- short output -> read raw
- large repetitive output + summary requested -> use `distill`
- debugging / exact diagnosis -> read raw first
- risky operation -> read raw first, optionally summarize second

---

## Response behavior
When reporting back after using `distill`:
- say it is a summary
- mention where the raw log is saved if applicable
- call out uncertainty if the summary may have omitted detail
- inspect the raw log before making strong claims about root cause

Good:
- “Summary from distilled test output: 3 failing tests in `foo.spec.ts`; raw log saved to `/tmp/test.log`.”

Bad:
- “These are definitely the only failures.”
```

---

# 5) What Model `distill` Recommends

## Recommended model

`distill` recommends **`qwen3.5:2b` via Ollama**.

Typical setup:

```bash
ollama pull qwen3.5:2b
distill config model "qwen3.5:2b"
distill config thinking false
```

## Why this recommendation makes sense

This is a recommendation for:

- local execution
- low cost
- speed
- enough context window for long logs
- acceptable extraction quality for narrow tasks

This is **not** a recommendation because it is the best possible summarizer.
It is a recommendation because it is cheap and fast enough to act as a preprocessing step.

---

# 6) How Good `qwen3.5:2b` Is for This Job

## My assessment

For the very specific job `distill` is doing, `qwen3.5:2b` is a **reasonable default**.

It is a good fit for:

- cheap log compression
- first-pass extraction
- grouping repeated issues
- converting long output into a short answer
- simple structured extraction when carefully prompted

It is **not** good enough to trust on its own for:

- deciding whether a Terraform plan is safe
- determining true root cause in flaky failures
- resolving ambiguous stack traces
- security triage without checking raw evidence
- any high-stakes inference task

## Best framing

Think of `qwen3.5:2b` as:

- **fast filter tier**
- **not truth / judgment tier**

That is exactly the right role for a small local model in this workflow.

---

# 7) Testing Plan: How to Check Whether Compression Is Good Enough

## Goal

The right question is not:

> “Does the summary sound plausible?”

The right question is:

> “Does the summary preserve the exact facts that matter under noisy real output?”

## Core dimensions to test

- pass/fail accuracy
- unique error extraction
- buried critical line retention
- JSON validity
- diff summarization fidelity
- overreach on risk/judgment prompts

---

# 8) Evaluation Rubric

Score each test from **0 to 2** in the following categories.

## Recall
- **2** = captured all important items
- **1** = missed minor items only
- **0** = missed important items

## Precision
- **2** = included only relevant items
- **1** = included some minor noise
- **0** = included false or misleading items

## Faithfulness
- **2** = matches raw output accurately
- **1** = mostly correct but loosely paraphrased
- **0** = materially misleading or incorrect

## Format Following
- **2** = followed requested format exactly
- **1** = mostly followed, minor issues
- **0** = did not follow requested format

## Compression Usefulness
- **2** = meaningfully smaller while preserving value
- **1** = somewhat useful
- **0** = little benefit or too lossy

**Total per test: 10**

Interpretation:

- **9–10** = strong
- **7–8** = usable with caution
- **5–6** = weak
- **0–4** = poor

---

# 9) Recommended Test Cases

## Test 1 — Pass / Fail Extraction

### Goal
Check whether the model correctly identifies whether tests passed and lists only failing tests.

### Commands

```bash
bun test 2>&1 | tee /tmp/distill-eval/bun-test.log | distill "did tests pass? if not, list only failing test names"
```

```bash
pytest -q 2>&1 | tee /tmp/distill-eval/pytest.log | distill "did tests pass? if not, list only failing tests"
```

```bash
npm test 2>&1 | tee /tmp/distill-eval/npm-test.log | distill "did tests pass? if not, list only failing suites and first error"
```

### What to check
- correct pass vs fail
- no missed failures
- no invented failures
- no padding with passing tests

---

## Test 2 — Unique Error Extraction from Noise

### Goal
Check whether the model can pull out real errors from noisy repetitive output.

### Commands

```bash
rg -n "error|warning|failed|exception|deprecated" . --glob '!node_modules' 2>&1 | tee /tmp/distill-eval/rg-errors.log | distill "list only true errors grouped by file; exclude warnings unless they indicate failure"
```

```bash
npm run lint 2>&1 | tee /tmp/distill-eval/lint.log | distill "list unique lint errors by file and rule; remove duplicates"
```

```bash
journalctl -n 1000 2>&1 | tee /tmp/distill-eval/journal.log | distill "extract only auth failures, permission denials, and fatal errors"
```

### What to check
- did it miss true errors?
- did it include warnings/noise incorrectly?
- did it dedupe repeated output properly?

---

## Test 3 — Buried Critical Line

### Goal
Check whether the model preserves a single decisive line buried in lots of harmless output.

### Command

```bash
(
  for i in $(seq 1 2000); do
    echo "INFO step=$i completed successfully"
  done
  echo "ERROR migration failed: duplicate key value violates unique constraint users_email_key"
  for i in $(seq 2001 4000); do
    echo "INFO cleanup step=$i completed successfully"
  done
) | tee /tmp/distill-eval/buried-critical-line.log | distill "what is the main problem?"
```

### Variant

```bash
(
  yes "INFO ok" | head -n 1500
  echo "WARNING using fallback credentials"
  yes "INFO ok" | head -n 1500
  echo "ERROR database migration failed: duplicate key on users.email"
  yes "INFO ok" | head -n 1500
) | tee /tmp/distill-eval/buried-critical-line-variant.log | distill "identify the real problem and ignore harmless noise"
```

### What to check
- did it preserve the decisive line?
- did it rank it as the main issue?
- did it paraphrase it correctly?

---

## Test 4 — Structured JSON Output

### Goal
Check whether the model can emit valid, parseable JSON.

### Commands

```bash
npm audit --json 2>&1 | tee /tmp/distill-eval/audit-json-source.log | distill "extract critical and high vulnerabilities as JSON with keys: package, severity, title, fix_version"
```

```bash
npm audit 2>&1 | tee /tmp/distill-eval/audit-text-source.log | distill "return valid JSON array of critical and high vulnerabilities with keys: package, severity, title, fix_version"
```

### Validation

```bash
jq . /path/to/distilled-output.json
```

### What to check
- valid JSON
- required keys present
- no missed critical items
- no incorrect merges/collapses

---

## Test 5 — Diff Summarization

### Goal
Check whether the model can summarize code changes accurately without overstating them.

### Commands

```bash
git diff HEAD~1..HEAD 2>&1 | tee /tmp/distill-eval/diff-last-commit.log | distill "summarize the functional changes by file in 5 bullets max"
```

```bash
git diff main...HEAD 2>&1 | tee /tmp/distill-eval/diff-branch.log | distill "summarize functional changes by file; call out config, schema, auth, or API changes separately"
```

### What to check
- correct files identified
- refactor vs behavior change distinguished
- config/schema/API changes not missed
- no inflated claims

---

## Test 6 — Risk / Judgment Boundary

### Goal
Check the difference between summarization and unsafe judgment.

### Commands

```bash
terraform plan -no-color 2>&1 | tee /tmp/distill-eval/tfplan-summary.log | distill "summarize resources added, changed, and destroyed"
```

```bash
terraform plan -no-color 2>&1 | tee /tmp/distill-eval/tfplan-safety.log | distill "is this safe?"
```

### What to check
- is the extraction-focused prompt accurate?
- does the safety prompt overreach?
- does it make unsupported claims?
- does it miss destructive actions?

### Expected result
It should perform better on extraction than on safety judgment.

---

## Test 7 — Install / Build Failure Boundary

### Goal
Check whether the model is safe for first-pass summaries of build/install failures.

### Commands

```bash
npm install 2>&1 | tee /tmp/distill-eval/npm-install.log | distill "summarize the main error only"
```

```bash
docker build . 2>&1 | tee /tmp/distill-eval/docker-build.log | distill "what is the first real error?"
```

```bash
pnpm install 2>&1 | tee /tmp/distill-eval/pnpm-install.log | distill "identify the actual failure line and any dependency causing it"
```

### What to check
- actual first failure identified
- warnings not mistaken for errors
- exact package/version issues preserved
- summary helps rather than hides

---

## Test 8 — Stack Trace Compression

### Goal
Check whether the model can reduce a stack trace without hiding the root exception.

### Command

```bash
cat crash.log | tee /tmp/distill-eval/crash.log.copy | distill "extract the root exception, first relevant application frame, and likely failing component"
```

### What to check
- real exception preserved
- app frames distinguished from framework noise
- no invented root cause
- useful compression achieved

---

# 10) Quick Score Table Template

Use this table to capture results:

| Test | Recall (0-2) | Precision (0-2) | Faithfulness (0-2) | Format (0-2) | Compression (0-2) | Total / 10 | Notes |
|------|--------------|-----------------|--------------------|--------------|-------------------|------------|-------|
| Pass / Fail |  |  |  |  |  |  |  |
| Error Extraction |  |  |  |  |  |  |  |
| Buried Critical Line |  |  |  |  |  |  |  |
| JSON Output |  |  |  |  |  |  |  |
| Diff Summary |  |  |  |  |  |  |  |
| Terraform Summary |  |  |  |  |  |  |  |
| Terraform Safety Judgment |  |  |  |  |  |  |  |
| Install / Build Failure |  |  |  |  |  |  |  |
| Stack Trace Compression |  |  |  |  |  |  |  |

---

# 11) Recommended Default Policy After Testing

If the results are good, the practical policy should be:

## Safe default use cases
- pass/fail summaries
- unique error extraction
- repeated log deduplication
- audit extraction
- high-level diff summaries

## Do not trust without raw output
- build failures
- stack traces
- auth/network/TLS issues
- database migrations
- Terraform safety decisions
- security decisions
- deployment failures

## Preferred pattern

```bash
<command> 2>&1 | tee /tmp/cmd.log | distill "<narrow extraction question>"
```

---

# 12) Red Flags

If any of these happen repeatedly, the model is too lossy for broad use:

- says tests passed when they failed
- omits one or more failing tests
- misses the only critical error line
- invents warnings/errors not present
- outputs invalid JSON repeatedly
- makes strong safety claims from infra output
- paraphrases in a way that changes meaning

---

# 13) Bottom Line

## Final recommendation

Use `distill` with `qwen3.5:2b` as a **targeted compression tool**, not as a universal shell-output replacement.

### Recommended role
- cheap local summarizer
- first-pass extractor
- token saver for repetitive output

### Not recommended role
- final authority on debugging
- root-cause engine
- infra safety judge
- security triage decision-maker

### Practical rule

> Use `distill` when the output is long and repetitive and the question is narrow.
> Preserve raw logs whenever the exact text might matter.
> For debugging and risky operations, read raw output first.

---

# 14) Personal Conclusion Template

Fill this in after testing:

> `qwen3.5:2b` via `distill` is / is not acceptable as a first-pass compressor for noisy CLI output in my workflow.

## Good enough for
- 
- 
- 

## Not good enough for
- 
- 
- 

## Conditions for safe use
- preserve raw output with `tee`
- use narrow prompts
- do not rely on it alone for debugging or safety decisions
