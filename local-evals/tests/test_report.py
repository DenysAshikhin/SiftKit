from local_evals.environment import Environment
from local_evals.records import SampleRecord, SampleStatus, TaskIssue
from local_evals.report import render_csv, render_markdown, summarize
from local_evals.siftkit import Identity


def record(sample_id: str, status: SampleStatus, task: str = "task/a", end: int | None = 1) -> SampleRecord:
    return SampleRecord(
        run_id="run-1",
        experiment_id=None,
        variant_id="preset-a",
        evaluator="inspect",
        task=task,
        task_version="1",
        sample_id=sample_id,
        dataset_revision=None,
        repeat=1,
        seed=42,
        raw_log="raw.eval",
        scorer="s",
        score=1.0 if status == "correct" else 0.0,
        status=status,
        prompt_tokens=10,
        output_tokens=5,
        reasoning_tokens=None,
        total_seconds=1.0,
        working_seconds=1.0,
        finish_reason="stop",
        model_calls=1,
        tool_calls=0,
        retries=None,
        error=None,
        residency_hash="abc",
        generation_start=1,
        generation_end=end,
    )


RECORDS = [
    record("1", "correct"),
    record("2", "incorrect"),
    record("3", "invalid_format"),
    record("4", "infra_error"),
    record("5", "correct", task="task/b", end=2),
]
PLANNED = {"task/a": 5, "task/b": 1}


def test_summary_separates_model_outcomes_from_operational_ones() -> None:
    by_task = {summary.task: summary for summary in summarize(RECORDS, PLANNED)}
    a = by_task["task/a"]
    assert (a.planned, a.completed, a.correct) == (5, 3, 1)
    assert a.accuracy_completed == 1 / 3 and a.accuracy_planned == 1 / 5
    assert a.counts["infra_error"] == 1 and a.reloaded is False
    b = by_task["task/b"]
    assert b.accuracy_completed == 1.0 and b.reloaded is True


def test_a_task_with_no_completed_samples_reports_no_accuracy() -> None:
    summary = summarize([record("1", "infra_error")], {"task/a": 2})[0]
    assert summary.accuracy_completed is None and summary.accuracy_planned == 0.0


IDENTITY = Identity.model_validate(
    {
        "requested": {"presetId": "preset-a", "settings": {"KvCacheQuantization": "q8_0", "NumCtx": 32000}},
        "resident": {
            "matches": True,
            "card": {
                "id": "served-model",
                "max_seq_len": 32000,
                "cache_size": 32000,
                "chunk_size": 2048,
                "cache_mode": None,
            },
        },
        "drafting": {"configured": False, "verified": None},
        "engine": {
            "managed": True,
            "pythonPath": "C:\\engine\\python.exe",
            "workingDirectory": "C:\\engine\\tabby",
            "entrypoint": "main.py",
            "environment": {},
        },
        "residency": {"keyHash": "abc", "generation": 9},
    }
)


def make_environment(
    identity: Identity | None, mocked: bool, unavailable: dict[str, str] | None = None
) -> Environment:
    return Environment(
        started_at_utc="2026-11-26T12:00:00Z",
        os="Windows-11",
        cpu=None,
        python="3.14.0",
        gpu=None,
        packages={},
        siftkit=None,
        tabbyapi=None,
        exllamav3_version=None,
        unavailable=unavailable or {},
        identity=identity,
        scrubbed_env=[],
        mocked=mocked,
    )


def test_markdown_states_identity_verification_and_mock_status() -> None:
    text = render_markdown(
        summarize(RECORDS, PLANNED),
        make_environment(IDENTITY, mocked=False),
        run_id="run-1",
        model="preset-a",
        generation="fixed-v1",
        digest="d" * 64,
        issues=[],
    )
    assert "| task/a | 5 | 3 | 1 | 33.3% | 20.0% |" in text
    assert "- KV cache: unverified (configured q8_0)" in text
    assert "- Context: 32000 (verified)" in text
    assert "- Drafting: configured False, unverified" in text
    assert "- Model reloaded during: task/b" in text
    assert "MOCKED" not in text
    assert "Tasks that did not produce samples" not in text

    mocked = render_markdown(
        [],
        make_environment(None, mocked=True),
        run_id="r",
        model="m",
        generation="g",
        digest="d",
        issues=[],
    )
    assert "MOCKED RUN" in mocked and "no model was called" in mocked
    assert "- Identity: not verified" in mocked
    assert "Environment not captured" not in mocked


def test_markdown_lists_environment_fields_that_could_not_be_captured() -> None:
    text = render_markdown(
        [],
        make_environment(None, mocked=True, unavailable={"gpu": "nvidia-smi could not be started: x"}),
        run_id="r",
        model="m",
        generation="g",
        digest="d",
        issues=[],
    )
    assert "- Environment not captured: gpu (nvidia-smi could not be started: x)" in text

    two = render_markdown(
        [],
        make_environment(
            None,
            mocked=True,
            unavailable={
                "tabbyapi": "git exited with code 128",
                "gpu": "nvidia-smi could not be started: x",
            },
        ),
        run_id="r",
        model="m",
        generation="g",
        digest="d",
        issues=[],
    )
    assert (
        "- Environment not captured: gpu (nvidia-smi could not be started: x); "
        "tabbyapi (git exited with code 128)" in two
    )


def test_markdown_lists_tasks_that_did_not_produce_samples() -> None:
    issue = TaskIssue(task="task/a", category="infra_error", detail="EvaluatorError: inspect wrote no log")
    text = render_markdown(
        summarize(RECORDS, PLANNED),
        make_environment(None, mocked=False),
        run_id="run-1",
        model="preset-a",
        generation="fixed-v1",
        digest="d" * 64,
        issues=[issue],
    )
    assert "## Tasks that did not produce samples" in text
    assert "- task/a: infra_error - EvaluatorError: inspect wrote no log" in text


def test_csv_has_one_row_per_task_and_blank_for_unknown() -> None:
    lines = render_csv(summarize([record("1", "infra_error")], {"task/a": 2})).strip().splitlines()
    header = lines[0].split(",")
    assert header[:6] == ["task", "planned", "completed", "accuracy_completed", "accuracy_planned", "correct"]
    assert len(header) == len(set(header))
    assert lines[1].startswith("task/a,2,0,,0.0,0,")
