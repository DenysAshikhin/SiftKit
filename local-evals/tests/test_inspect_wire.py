from pathlib import Path

import pytest

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from tests.capture_server import capture_server

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


def test_the_generation_profile_and_output_budget_reach_the_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with capture_server() as server:
        monkeypatch.setenv("SIFTBENCH_BASE_URL", server.base_url)
        monkeypatch.setenv("SIFTBENCH_API_KEY", "local")
        evaluator = InspectEvaluator()
        log = evaluator.run(
            TaskRunRequest(
                task="local_evals/structured_output",
                task_args={},
                model="openai-api/siftbench/preset-a",
                model_args={},
                sample_ids=["so-001"],
                limit=None,
                generation=GENERATION,
                max_tokens=256,
                max_retries=1,
                timeout_seconds=60,
                log_dir=tmp_path / "log",
            )
        )
        samples = list(evaluator.read_samples(log))

    assert [(sample.sample_id, sample.status, sample.prompt_tokens) for sample in samples] == [
        ("so-001", "invalid_format", 3),
    ]
    assert len(server.chat_requests()) == 1
    sent = server.chat_requests()[0]
    assert sent.path == "/bench/v1/chat/completions"
    assert sent.headers["authorization"] == "Bearer local"
    assert sent.body["model"] == "preset-a"
    assert sent.body.get("max_tokens", sent.body.get("max_completion_tokens")) == 256
    assert (sent.body["temperature"], sent.body["top_p"], sent.body["seed"]) == (1.0, 0.95, 42)
    assert (sent.body["top_k"], sent.body["min_p"]) == (20, 0.0)
    assert sent.body["chat_template_kwargs"] == {"enable_thinking": True, "reasoning_effort": "xhigh"}
