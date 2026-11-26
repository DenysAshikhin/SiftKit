import dataclasses
import json
from pathlib import Path

import pytest
from inspect_ai.model import ModelOutput

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import EvaluatorError, MockModel, RawLogRef, TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.paths import FIXTURES
from local_evals.tasks.structured import load_cases

CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
TASK = "local_evals/structured_output"
GENERATION = GenerationProfile(
    name="fixed-v1",
    temperature=1.0,
    top_p=0.95,
    top_k=20,
    min_p=0.0,
    seed=42,
    enable_thinking=True,
    reasoning_effort="xhigh",
)


def request(log_dir: Path, outputs: list[str | ModelOutput], limit: int | None = 3) -> TaskRunRequest:
    custom: list[ModelOutput] = []
    for text in outputs:
        custom.append(ModelOutput.from_content("mockllm/model", text) if isinstance(text, str) else text)
    return TaskRunRequest(
        task=TASK,
        task_args={},
        model=MockModel(evaluator_args={"custom_outputs": custom}),
        sample_ids=None,
        limit=limit,
        generation=GENERATION,
        max_tokens=256,
        max_retries=1,
        timeout_seconds=60,
        log_dir=log_dir,
    )


def test_structured_task_runs_and_normalizes_correct_invalid_and_wrong(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    wrong = json.dumps({**CASES[2].expected, "room": "C9"})
    log = evaluator.run(request(tmp_path / "log", [json.dumps(CASES[0].expected), "Sure! {}", wrong]))

    assert log.path.suffix == ".eval" and log.path.is_file() and log.task == TASK
    samples = sorted(evaluator.read_samples(log), key=lambda sample: sample.sample_id)
    assert [(sample.sample_id, sample.status, sample.score) for sample in samples] == [
        ("so-001", "correct", 1.0),
        ("so-002", "invalid_format", 0.0),
        ("so-003", "incorrect", 0.0),
    ]
    assert all(sample.task == TASK and sample.repeat == 1 for sample in samples)
    assert all(sample.scorer == "structured_scorer" and sample.model_calls == 1 for sample in samples)
    assert samples[0].finish_reason == "stop"


def test_a_cut_off_answer_is_truncated_and_an_overlong_prompt_is_input_too_long(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    # Schema-valid but wrong value, so the scorer's invalid_format override stays out of the way.
    cut_off = json.dumps({**CASES[0].expected, "shipping": "standard"})
    outputs: list[str | ModelOutput] = [
        ModelOutput.from_content(model="mockllm/model", content=cut_off, stop_reason="max_tokens"),
        ModelOutput.from_content(model="mockllm/model", content="{}", stop_reason="model_length"),
    ]
    log = evaluator.run(request(tmp_path / "log", outputs, limit=2))
    samples = sorted(evaluator.read_samples(log), key=lambda sample: sample.sample_id)
    assert [(sample.sample_id, sample.status, sample.finish_reason) for sample in samples] == [
        ("so-001", "truncated", "max_tokens"),
        ("so-002", "input_too_long", "model_length"),
    ]


def test_selected_sample_ids_run_exactly_those_samples(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    selected = dataclasses.replace(
        request(tmp_path / "log", ["{}", "{}"], limit=None), sample_ids=["so-005", "so-002"]
    )
    samples = list(evaluator.read_samples(evaluator.run(selected)))
    assert sorted(sample.sample_id for sample in samples) == ["so-002", "so-005"]


def test_unknown_local_task_and_unreadable_log_are_evaluator_errors(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    unknown = dataclasses.replace(request(tmp_path / "log", []), task="local_evals/no_such_task")
    with pytest.raises(EvaluatorError, match="no_such_task"):
        evaluator.run(unknown)
    broken = tmp_path / "broken.eval"
    broken.write_bytes(b"not a log")
    with pytest.raises(EvaluatorError, match="broken.eval"):
        list(evaluator.read_samples(RawLogRef("inspect", broken, TASK)))
    missing = tmp_path / "missing.eval"
    with pytest.raises(EvaluatorError, match="missing.eval"):
        list(evaluator.read_samples(RawLogRef("inspect", missing, TASK)))


def test_two_runs_into_one_log_directory_each_return_their_own_log(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    log_dir = tmp_path / "log"
    first = evaluator.run(request(log_dir, [json.dumps(CASES[0].expected)], limit=1))
    second = evaluator.run(request(log_dir, ["Sure! {}"], limit=1))
    assert first.path != second.path
    assert first.path.is_file() and second.path.is_file()
    assert [sample.status for sample in evaluator.read_samples(first)] == ["correct"]
    assert [sample.status for sample in evaluator.read_samples(second)] == ["invalid_format"]
