"""The boundary every evaluation harness is adapted to. Nothing here imports a harness."""

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import JsonValue

from local_evals.config import GenerationProfile
from local_evals.records import EvaluatedSample, SampleStatus


class EvaluatorError(Exception):
    """The evaluator could not run a task or its log could not be read."""


@dataclass(frozen=True)
class TaskRunRequest:
    task: str
    task_args: Mapping[str, JsonValue]
    model: str
    model_args: Mapping[str, object]
    # None runs the task's own sample order, capped by `limit`.
    sample_ids: Sequence[str] | None
    limit: int | None
    generation: GenerationProfile
    max_tokens: int
    max_retries: int
    timeout_seconds: int
    log_dir: Path


@dataclass(frozen=True)
class RawLogRef:
    evaluator: str
    path: Path
    # The task id as requested, so normalized samples carry the catalogue id, not the harness's own name.
    task: str


class Evaluator(Protocol):
    name: str

    def run(self, request: TaskRunRequest) -> RawLogRef: ...

    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]: ...


def classify_status(
    *,
    errored: bool,
    timed_out: bool,
    input_too_long: bool,
    output_truncated: bool,
    score: float | None,
    override: SampleStatus | None,
) -> SampleStatus:
    """Maps one sample to a status. Infrastructure and limits outrank the score."""
    if errored:
        return "infra_error"
    if timed_out:
        return "timeout"
    if input_too_long:
        return "input_too_long"
    if override is not None:
        return override
    if score is None:
        return "infra_error"
    if score >= 1.0:
        return "correct"
    return "truncated" if output_truncated else "incorrect"
