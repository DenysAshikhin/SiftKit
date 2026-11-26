"""Normalized per-sample outcome, independent of the evaluator that produced it."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

SampleStatus = Literal[
    "correct",
    "incorrect",
    "invalid_format",
    "truncated",
    "input_too_long",
    "timeout",
    "infra_error",
    "unavailable",
    "skipped",
]

# Outcomes the model produced. Everything else is operational and never counts as a wrong answer.
MODEL_OUTCOMES: frozenset[SampleStatus] = frozenset({"correct", "incorrect", "invalid_format", "truncated"})


class EvaluatedSample(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task: str
    task_version: str | None
    sample_id: str
    dataset_revision: str | None
    repeat: int
    scorer: str | None
    score: float | None
    status: SampleStatus
    prompt_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    total_seconds: float | None
    working_seconds: float | None
    finish_reason: str | None
    model_calls: int | None
    tool_calls: int | None
    retries: int | None
    error: str | None


class SampleRecord(EvaluatedSample):
    run_id: str
    experiment_id: str | None
    variant_id: str
    evaluator: str
    seed: int | None
    raw_log: str
    residency_hash: str | None
    # Runtime generation read before and after the task; a difference means the model was reloaded.
    generation_start: int | None
    generation_end: int | None


TaskIssueCategory = Literal["skipped", "unavailable", "infra_error"]


class TaskIssue(BaseModel):
    """A whole task produced no samples, so the report must say why."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    task: str
    category: TaskIssueCategory
    detail: str
