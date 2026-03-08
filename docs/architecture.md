# SiftKit Architecture

## Design

SiftKit has four layers:

1. Public PowerShell commands for bootstrap, summarization, command execution, evaluation, and Codex policy install.
2. A policy layer that decides whether output should stay raw, be reduced first, or be summarized with a raw-review warning.
3. A provider layer with a stable contract for backend health checks, model discovery, and summarization.
4. A fixture and scoring layer for benchmark-style evaluation.

## Conservative policy

The core policy encoded from `distill_codex_recommendation.md` is:

- short output stays raw
- large informational output can summarize
- debug and risky output stays raw-first and any summary is secondary
- managed command execution always preserves the raw combined log
- deterministic reduction happens before model summarization when possible

## Provider contract

Each provider supplies three operations:

- availability and health check
- model listing
- summarization from a prompt and model id

v1 only ships an Ollama provider, but the module keeps provider registration isolated so more backends can be added without changing the public command surface.

## Evaluation flow

`Invoke-SiftEvaluation` loads fixture metadata, runs the configured backend against each source file, and scores the result with a lightweight rubric:

- recall
- precision
- faithfulness
- format following
- compression usefulness

Synthetic fixtures are scored automatically. Real logs are included in the same result artifact but marked for manual review.
