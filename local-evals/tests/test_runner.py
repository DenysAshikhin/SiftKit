import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from inspect_ai.model import ModelOutput

from local_evals.config import (
    Endpoint,
    ResolvedManifest,
    Suite,
    SuiteTask,
    TaskCatalog,
    load_yaml,
    resolve_manifest,
)
from local_evals.environment import Environment
from local_evals.evaluators.base import EvaluatorError, LiveModel, RawLogRef, TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.paths import FIXTURES, PROJECT_ROOT, REPO_ROOT
from local_evals.records import EvaluatedSample, SampleRecord, TaskIssue
from local_evals.runner import LiveTarget, MockTarget, RunError, run_suite
from local_evals.siftkit import BenchClient
from local_evals.tasks.structured import load_cases
from tests.fake_bench import RESIDENCY, FakeBench

CONFIGS = PROJECT_ROOT / "configs"
CATALOG = load_yaml(CONFIGS / "tasks.yaml", TaskCatalog)
CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
NOW = datetime(2026, 11, 26, 12, 0, 0, tzinfo=UTC)
ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)
EVALUATORS = {"inspect": InspectEvaluator()}


def structured_manifest(limit: int) -> ResolvedManifest:
    base = resolve_manifest(
        CONFIGS, endpoint="siftkit-local", model="preset-a", suite="structured", generation="fixed-v1"
    )
    suite = Suite(
        name="structured",
        tasks=[SuiteTask(task="local_evals/structured_output", limit=limit, max_tokens=256)],
    )
    return base.model_copy(update={"suite": suite})


def mock_outputs(outputs: list[str]) -> dict[str, object]:
    return {"custom_outputs": [ModelOutput.from_content("mockllm/model", text) for text in outputs]}


class StubEvaluator:
    """Stands in for InspectEvaluator in live-target tests, where no model call should happen."""

    name = "inspect"

    def __init__(self, samples: list[EvaluatedSample], error: EvaluatorError | None = None) -> None:
        self.requests: list[TaskRunRequest] = []
        self.samples = samples
        self.error = error

    def run(self, request: TaskRunRequest) -> RawLogRef:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return RawLogRef(self.name, request.log_dir / "stub.eval", request.task)

    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]:
        yield from self.samples


def canned_sample() -> EvaluatedSample:
    return EvaluatedSample(
        task="local_evals/structured_output",
        task_version="1",
        sample_id="so-001",
        dataset_revision=None,
        repeat=1,
        scorer="structured",
        score=1.0,
        status="correct",
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
    )


def test_mock_run_writes_samples_environment_and_completed_state(tmp_path: Path) -> None:
    target = MockTarget(evaluator_args=mock_outputs([json.dumps(CASES[0].expected), "not json"]))
    store = run_suite(structured_manifest(2), CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)

    records = [SampleRecord.model_validate(row) for row in store.read_jsonl("samples.jsonl")]
    assert sorted((record.sample_id, record.status) for record in records) == [
        ("so-001", "correct"),
        ("so-002", "invalid_format"),
    ]
    assert all(record.run_id == store.run_id and record.variant_id == "preset-a" for record in records)
    assert all(record.seed == 42 and record.residency_hash is None for record in records)
    assert all(Path(record.raw_log).is_file() for record in records)
    environment = Environment.model_validate(store.read_json("environment.json"))
    assert environment.mocked is True and environment.identity is None
    assert store.read_json("state.json")["status"] == "completed"
    assert store.read_jsonl("errors.jsonl") == []


def test_live_target_warms_verifies_identity_and_brackets_the_task_with_generations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-be-removed")
    fake = FakeBench(generation=9)
    stub = StubEvaluator([canned_sample()])
    target = LiveTarget(client=BenchClient(ENDPOINT, None, transport=fake.transport()), api_key=None)
    manifest = structured_manifest(1)

    store = run_suite(manifest, CATALOG, {"inspect": stub}, target, tmp_path, REPO_ROOT, NOW)

    warm = fake.bodies("/chat/completions")[0]
    assert warm["model"] == "preset-a" and warm["max_tokens"] == 1
    (request,) = stub.requests
    task = manifest.suite.tasks[0]
    assert request.model == LiveModel(preset="preset-a", endpoint=manifest.endpoint, api_key=None)
    assert (request.limit, request.max_tokens) == (task.limit, task.max_tokens)
    assert request.generation == manifest.generation
    record = SampleRecord.model_validate(store.read_jsonl("samples.jsonl")[0])
    assert (record.residency_hash, record.generation_start, record.generation_end) == (RESIDENCY, 9, 9)
    environment = Environment.model_validate(store.read_json("environment.json"))
    assert environment.mocked is False
    assert "OPENAI_API_KEY" in environment.scrubbed_env


def test_live_run_does_not_set_siftbench_environment_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SIFTBENCH_BASE_URL", raising=False)
    monkeypatch.delenv("SIFTBENCH_API_KEY", raising=False)
    fake = FakeBench(generation=9)
    target = LiveTarget(client=BenchClient(ENDPOINT, None, transport=fake.transport()), api_key=None)
    run_suite(
        structured_manifest(1),
        CATALOG,
        {"inspect": StubEvaluator([canned_sample()])},
        target,
        tmp_path,
        REPO_ROOT,
        NOW,
    )
    assert "SIFTBENCH_BASE_URL" not in os.environ
    assert "SIFTBENCH_API_KEY" not in os.environ


def test_identity_mismatch_and_failed_warm_up_abort_before_any_run_directory_exists(tmp_path: Path) -> None:
    stubs = {"inspect": StubEvaluator([])}
    for fake, pattern in (
        (FakeBench(resident=None), "does not match"),
        (FakeBench(chat_status=502), "HTTP 502"),
    ):
        target = LiveTarget(client=BenchClient(ENDPOINT, None, transport=fake.transport()), api_key=None)
        with pytest.raises(RunError, match=pattern):
            run_suite(structured_manifest(1), CATALOG, stubs, target, tmp_path, REPO_ROOT, NOW)
    assert list(tmp_path.iterdir()) == []


def test_a_failing_task_is_recorded_and_the_run_continues(tmp_path: Path) -> None:
    suite = Suite(
        name="mixed",
        tasks=[
            SuiteTask(
                task="local_evals/structured_output",
                limit=1,
                max_tokens=256,
                task_args={"fixture": "missing.jsonl"},
            ),
            SuiteTask(task="local_evals/structured_output", limit=1, max_tokens=256),
        ],
    )
    manifest = structured_manifest(1).model_copy(update={"suite": suite})
    target = MockTarget(evaluator_args=mock_outputs([json.dumps(CASES[0].expected)]))

    store = run_suite(manifest, CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)

    (issue,) = [TaskIssue.model_validate(row) for row in store.read_jsonl("errors.jsonl")]
    assert (issue.task, issue.category) == ("local_evals/structured_output", "infra_error")
    assert "missing.jsonl" in issue.detail
    assert [row["status"] for row in store.read_jsonl("samples.jsonl")] == ["correct"]
