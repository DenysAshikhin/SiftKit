# Comparing runtime runs by exact identity

Run logs (`run_logs` in `runtime.sqlite`) record the canonical identity of every run from
schema version **57** onward. This document fixes the grouping key that comparison reports
should use, and states what can and cannot be compared for rows written before that version.

## Canonical comparison key

Group runs by this tuple. Every field is a column on `run_logs` and a field on the dashboard
`RunRecord` contract (`packages/contracts/src/runs.ts`).

```text
operationType
operationPresetId + operationPresetJson
modelPresetId + modelPresetJson
model
backend
```

| Field | Column | Meaning |
| --- | --- | --- |
| `operationType` | `operation_type` | The original operation: `summary`, `repo-search`, `repo-agent`, `plan`, or `chat`. Captured before the engine collapses `repo-agent` into the `repo_search` grouping. |
| `operationPresetId` | `operation_preset_id` | Id of the operation preset (`config.Presets`) the run resolved. |
| `operationPresetJson` | `operation_preset_json` | Validated JSON snapshot of that preset as it was at execution time. |
| `modelPresetId` | `model_preset_id` | Id of the model preset the run executed under. Chat runs record the session's referenced preset, not the global active one. |
| `modelPresetJson` | `model_preset_json` | Validated JSON snapshot of that model preset at execution time. |
| `model` | `model` | Model override or configured model string, unchanged from before. |
| `backend` | `backend` | Inference engine id (`llama` or `exl3`), unchanged from before. |

Pair each id with its snapshot on purpose. Two runs that share `operationPresetId` but differ
in `operationPresetJson` ran under different edits of the same preset and must not be pooled
as one condition. The same holds for `modelPresetId` and `modelPresetJson`. When a preset is
deleted, the snapshot on the row remains, so the run stays comparable.

Snapshots are stored and exposed as raw JSON text, exactly as written. Parse them with the
preset schemas when a report needs their fields.

## `run_kind` remains the coarse grouping

`run_kind` and `run_group` are the dashboard's compatibility grouping and are untouched:
existing filters, list/detail queries, and deletion criteria behave exactly as before. A
`repo-agent` run still lists under `run_kind = 'repo_search'` and the `repo_search` group; its
`operationType` is where the exact identity lives.

## What null means

A null identity field means **not recorded**. It never means "the default preset" or "the
active preset at the time". Consumers must not substitute a default when a value is missing.

Rows whose `run_kind` is `failed_request`, `request_abandoned`, or `unknown` have no canonical
operation type by design; they describe a failure or abandonment record, not an operation.

## Pre-migration rows (schema version 56 and earlier)

Migration 57 backfills only what the stored `run_kind` proves:

| Legacy `run_kind` | Backfilled `operationType` |
| --- | --- |
| `summary_request` | `summary` |
| `plan` | `plan` |
| `chat` | `chat` |
| `repo_search` | `repo-search` |
| `failed_request`, `request_abandoned`, `unknown` | null |

All preset identity fields stay null on pre-migration rows: no earlier schema recorded them.

**Repo-agent rows cannot be identified from `run_logs` alone.** Before version 57 the engine
collapsed `repo-agent` into `repo_search` before persisting anything, and no stored column,
artifact, or transcript field carries the original kind. Pre-migration `repo_search` rows
therefore read as `repo-search` even when the run was actually a repo-agent run. The auxiliary
`.siftkit/repo-agent/runs` directories used to reconstruct that distinction in the Aug 27-31
analysis are not durable database history and are not consulted by the migration.

Any comparison that mixes rows from before and after version 57 must state this boundary and
treat pre-migration `repo-search` rows as "repo-search or repo-agent".

## Where identity is captured

- Engine runs (`repo-search`, `repo-agent`, `plan`, `chat`): `executeRepoSearchRequest`
  resolves the operation preset and the model preset (from the session snapshot when the
  caller supplies one, otherwise the active preset of the configuration it ran with) and
  persists them on both the completed and the failed path.
- Summary runs: the summary runner stamps identity into the `summary_request` artifact, which
  crosses the status HTTP boundary as a deferred artifact and is validated again when it is
  written to `run_logs`.
- Admissions for the repo-search and repo-agent routes record identity as soon as the run is
  admitted, so a run that fails before the engine runs still carries its operation.
