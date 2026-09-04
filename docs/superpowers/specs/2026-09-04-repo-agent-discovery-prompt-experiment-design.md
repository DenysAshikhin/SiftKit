# Repo-Agent Discovery Prompt Experiment Design

## Purpose

Measure whether search-first and question-bounded discovery guidance reduces repo-agent read cost without reducing verified task completion or implementation quality. The experiment must distinguish prompt effects from model, repository, ordering, fixture, and accounting differences.

## Scope

Build a dedicated repo-agent experiment harness. The existing benchmark and benchmark-matrix code drives summary requests, so it is not extended or generalized. The new harness reuses the existing repo-agent API, prompt-prefix field, status client, runtime database, benchmark-result persistence, PowerShell execution helper, and repository test runner.

The first experiment tests discovery guidance only. It does not change the built-in repo-agent prompt, read governor, edit implementation, compaction behavior, or `oldText` diagnostics.

## Prompt Arms

Use a two-factor, four-arm design so each instruction and their interaction can be measured:

| Arm | Search-first factor | Question-bounded factor |
|---|---:|---:|
| `control` | off | off |
| `search-first` | on | off |
| `question-bounded` | off | on |
| `combined` | on | on |

The control sends no additional prompt prefix. The combined arm concatenates the two factor files in a fixed order; it does not maintain a duplicated third prompt.

Search-first factor text:

```text
Discovery routing:
- Locate candidate symbols, callers, tests, and configuration with grep or find before opening files.
- Read a file only after search identifies a candidate location. If the exact target path and lines are already known, read them directly.
- Do not replace necessary code reading with guesses.
```

Question-bounded factor text:

```text
Discovery stopping:
- Every read must answer a concrete unresolved question about the requested change.
- Read the smallest contiguous window that can answer that question, and expand only while the question remains unresolved.
- Once the evidence supports an edit and its validation, stop discovering and act.
- Do not skip verification or guess at unseen behavior to reduce reads.
```

## Workloads

Use four deterministic, dependency-free TypeScript fixture repositories. Each fixture has visible tests, immutable protected paths, and an independent validation command.

1. `port-parser`: localized boundary bug in one implementation file.
2. `handler-registration`: cross-file call-path bug requiring registry and handler inspection.
3. `duplicate-decoy`: two same-named implementations where only the runtime call path is relevant.
4. `usage-contract`: a producer-normalizer-reporter contract change spanning several files.

Every live run receives a fresh copy of the fixture repository. The harness never runs repo-agent against the SiftKit working tree and never uses Git worktrees. Fixture tests and manifests are hashed before the run; mutation of a protected path invalidates the result even if validation passes.

## Experimental Stages

### Pilot

Run all four arms once against all four workloads: 16 runs. Rotate arm order by case using a deterministic Latin-square schedule. The pilot validates the harness and identifies dominated prompts; it is not treated as statistically conclusive.

An arm advances only if it has no verified-completion regression relative to control and reduces read-result tokens on at least three of four cases. If several arms advance, choose the arm with the lowest median paired read-token ratio; break ties using p75 read-token ratio, then wall duration.

### Confirmation

Run control and the selected candidate three times against all four workloads: 24 runs. Rotate pair order by case and repetition.

The candidate wins only if:

- it has at most one fewer verified completion than control across 12 paired tasks;
- median and p75 paired read-token ratios are each at most `0.85`;
- compaction/context failures do not increase;
- edit-rejection rate does not increase by more than five percentage points;
- no protected-path or out-of-scope mutation is accepted.

If no arm clears the pilot gate, stop without changing the built-in prompt. If the confirmation gate fails, keep the current prompt and report the failure mode.

## Measurements

For each run record:

- public repo-agent terminal result;
- inner `run_logs.run_id`, correlated by unique disposable `repo_root` and start time;
- independent validation exit codes and output summaries;
- protected-path integrity;
- preflight/model turns: count of `turn_preflight_start`;
- tool-bearing turns: distinct `(run_id, turn)` among `turn_command_result`;
- maximum observed turn: maximum numeric event turn, labeled as a position rather than a count;
- read calls, read-result tokens, unique read paths, repeat-path reads, and exhausted-read rejections;
- edit attempts, successful edits, all rejections, and `oldText not found` failures;
- compaction attempts/failures, provider failures, duration, and terminal state.

Resolve the effective model from transcript `run_start.configuredModel`, falling back to `run_logs.model`. Resolve tool names from `toolName`, then `requestedCommand`, then `executedCommand`. Recognize structured rejection fields first and both `Rejected:` prefixes as text fallbacks.

## Outputs

Write one JSON artifact and one Markdown report under `eval/results/repo-agent-prompt-experiment/discovery-guidance-v1/`, and persist the JSON through `persistBenchmarkRun`. The report contains per-run evidence, paired case deltas, arm aggregates, pilot promotion, and confirmation verdict. Raw transcripts remain in `run_logs`; the experiment does not duplicate them.

## Safety and Reproducibility

- Run one live repo-agent at a time because the local model queue is exclusive.
- Require a healthy status server and configured model before creating any workspace.
- Fix model, sampler configuration, approval mode, maximum turns, fixture bytes, validation commands, and prompt-factor bytes for an experiment id.
- Store SHA-256 digests of the manifest, prompt factors, and fixture templates in the artifact.
- Clean only directories created beneath the experiment-owned temporary root and carrying its marker file.
- Do not modify, stage, commit, reset, or clean the SiftKit working tree.
- Do not use subagents.
