import pytest
from pydantic import ValidationError

from local_evals.evaluators.base import classify_status
from local_evals.records import EvaluatedSample, SampleRecord


def test_infrastructure_and_limits_outrank_the_score() -> None:
    assert (
        classify_status(
            errored=True,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=1.0,
            override=None,
        )
        == "infra_error"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=True,
            input_too_long=False,
            output_truncated=False,
            score=None,
            override=None,
        )
        == "timeout"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=True,
            output_truncated=False,
            score=0.0,
            override=None,
        )
        == "input_too_long"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=None,
            override=None,
        )
        == "infra_error"
    )


def test_model_outcomes() -> None:
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=1.0,
            override=None,
        )
        == "correct"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=0.0,
            override=None,
        )
        == "incorrect"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=0.5,
            override=None,
        )
        == "incorrect"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=True,
            score=0.0,
            override=None,
        )
        == "truncated"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=True,
            score=1.0,
            override=None,
        )
        == "correct"
    )
    assert (
        classify_status(
            errored=False,
            timed_out=False,
            input_too_long=False,
            output_truncated=False,
            score=0.0,
            override="invalid_format",
        )
        == "invalid_format"
    )


def test_a_sample_record_is_the_evaluated_sample_plus_run_context() -> None:
    sample = EvaluatedSample(
        task="add",
        task_version=None,
        sample_id="s1",
        dataset_revision=None,
        repeat=0,
        scorer=None,
        score=1.0,
        status="correct",
        prompt_tokens=10,
        output_tokens=5,
        reasoning_tokens=None,
        total_seconds=1.5,
        working_seconds=1.2,
        finish_reason="stop",
        model_calls=1,
        tool_calls=None,
        retries=0,
        error=None,
    )
    record = SampleRecord(
        **sample.model_dump(),
        run_id="run-1",
        experiment_id=None,
        variant_id="v1",
        evaluator="inspect",
        seed=42,
        raw_log="log/s1",
        residency_hash="hash-1",
        generation_start=3,
        generation_end=3,
    )
    expected = sample.model_dump()
    expected.update(
        {
            "run_id": "run-1",
            "experiment_id": None,
            "variant_id": "v1",
            "evaluator": "inspect",
            "seed": 42,
            "raw_log": "log/s1",
            "residency_hash": "hash-1",
            "generation_start": 3,
            "generation_end": 3,
        }
    )
    assert record.model_dump() == expected
    with pytest.raises(ValidationError):
        SampleRecord.model_validate({**record.model_dump(), "surprise": "x"})
