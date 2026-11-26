# pyright: reportUnknownVariableType=false
"""Adapter to Inspect AI. With tasks/inspect_bindings.py, the only code that imports inspect_ai."""

from collections.abc import Iterator, Mapping
from pathlib import Path

from inspect_ai import Task
from inspect_ai import eval as inspect_eval
from inspect_ai.log import EvalLog, EvalSample, read_eval_log
from inspect_ai.scorer import value_to_float
from pydantic import JsonValue

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import (
    EvaluatorError,
    RawLogRef,
    TaskRunRequest,
    classify_status,
)
from local_evals.records import EvaluatedSample, SampleStatus
from local_evals.tasks.inspect_bindings import structured_output

LOCAL_PREFIX = "local_evals/"


def _resolve_task(task: str, task_args: Mapping[str, JsonValue]) -> Task | str:
    """A registry name for upstream tasks; a built Task for this package's own."""
    if not task.startswith(LOCAL_PREFIX):
        return task
    if task == "local_evals/structured_output":
        fixture = task_args.get("fixture", "structured/v1.jsonl")
        if not isinstance(fixture, str):
            raise EvaluatorError("structured_output: task_args.fixture must be a string.")
        return structured_output(fixture)
    raise EvaluatorError(f"Unknown local task {task!r}.")


def _extra_body(generation: GenerationProfile) -> dict[str, JsonValue]:
    template: dict[str, JsonValue] = {"enable_thinking": generation.enable_thinking}
    if generation.enable_thinking and generation.reasoning_effort is not None:
        template["reasoning_effort"] = generation.reasoning_effort
    body: dict[str, JsonValue] = {"chat_template_kwargs": template}
    if generation.top_k is not None:
        body["top_k"] = generation.top_k
    if generation.min_p is not None:
        body["min_p"] = generation.min_p
    return body


def _status_override(claimed: object) -> SampleStatus | None:
    """A scorer may mark a failure as the model's formatting or truncation; nothing else is overridable."""
    if claimed == "invalid_format":
        return "invalid_format"
    if claimed == "truncated":
        return "truncated"
    return None


class InspectEvaluator:
    name = "inspect"

    def run(self, request: TaskRunRequest) -> RawLogRef:
        task = _resolve_task(request.task, request.task_args)
        request.log_dir.mkdir(parents=True, exist_ok=True)
        logs = inspect_eval(
            tasks=task,
            # Local tasks receive their arguments when built; upstream tasks receive them here.
            task_args={} if isinstance(task, Task) else dict(request.task_args),
            model=request.model,
            model_args=dict(request.model_args),
            sample_id=list(request.sample_ids) if request.sample_ids is not None else None,
            limit=request.limit,
            log_dir=str(request.log_dir),
            log_format="eval",
            display="none",
            fail_on_error=False,
            max_samples=1,
            max_connections=1,
            max_retries=request.max_retries,
            timeout=request.timeout_seconds,
            max_tokens=request.max_tokens,
            temperature=request.generation.temperature,
            top_p=request.generation.top_p,
            seed=request.generation.seed,
            extra_body=_extra_body(request.generation),
        )
        if not logs:
            raise EvaluatorError(f"Inspect wrote no log for {request.task} in {request.log_dir}.")
        # A local log's location is a plain filesystem path, not a URI.
        return RawLogRef(self.name, Path(logs[0].location), request.task)

    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]:
        try:
            eval_log = read_eval_log(str(log.path))
        except Exception as error:
            raise EvaluatorError(f"Cannot read {log.path}: {error}") from error
        if eval_log.samples is None:
            raise EvaluatorError(f"{log.path} holds no samples (status {eval_log.status}).")
        for sample in eval_log.samples:
            yield _normalize(eval_log, sample, log.task)


def _normalize(eval_log: EvalLog, sample: EvalSample, task: str) -> EvaluatedSample:
    scorer_name: str | None = None
    score: float | None = None
    override: SampleStatus | None = None
    if sample.scores:
        scorer_name, first = next(iter(sample.scores.items()))
        if isinstance(first.value, str | int | float | bool):
            score = value_to_float()(first.value)
        override = _status_override((first.metadata or {}).get("status"))
    usage = sample.output.usage
    limit_type = sample.limit.type if sample.limit is not None else None
    return EvaluatedSample(
        task=task,
        task_version=str(eval_log.eval.task_version),
        sample_id=str(sample.id),
        # Inspect exposes no dataset revision; the pinned evaluator release stands in for it.
        dataset_revision=None,
        repeat=sample.epoch,
        scorer=scorer_name,
        score=score,
        status=classify_status(
            errored=sample.error is not None,
            timed_out=limit_type in ("time", "working"),
            input_too_long=sample.output.stop_reason == "model_length",
            output_truncated=sample.output.stop_reason == "max_tokens",
            score=score,
            override=override,
        ),
        prompt_tokens=usage.input_tokens if usage is not None else None,
        output_tokens=usage.output_tokens if usage is not None else None,
        reasoning_tokens=usage.reasoning_tokens if usage is not None else None,
        total_seconds=sample.total_time,
        working_seconds=sample.working_time,
        finish_reason=sample.output.stop_reason,
        model_calls=sum(1 for event in sample.events if event.event == "model"),
        tool_calls=sum(1 for event in sample.events if event.event == "tool"),
        # Inspect does not expose per-sample HTTP retries.
        retries=None,
        error=sample.error.message if sample.error is not None else None,
    )
