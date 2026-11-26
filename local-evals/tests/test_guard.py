import pytest

from local_evals.guard import (
    CloudEndpointError,
    assert_local_model,
    assert_loopback,
    scrub_cloud_keys,
)


def test_loopback_urls_pass_and_everything_else_is_refused() -> None:
    assert_loopback("http://127.0.0.1:4765/bench/v1")
    assert_loopback("http://localhost:4765/bench/v1")
    assert_loopback("http://[::1]:4765/bench/v1")
    for url in ("https://api.openai.com/v1", "http://192.168.1.20:4765/bench/v1", "not a url"):
        with pytest.raises(CloudEndpointError):
            assert_loopback(url)


def test_only_the_bench_provider_and_the_mock_model_are_local() -> None:
    assert_local_model("openai-api/siftbench/exl3-preset", "siftbench")
    assert_local_model("mockllm/model", "siftbench")
    for model in ("openai/gpt-x", "anthropic/claude-x", "openai-api/other/model"):
        with pytest.raises(CloudEndpointError):
            assert_local_model(model, "siftbench")


def test_scrub_removes_cloud_keys_and_reports_their_names_only() -> None:
    environ = {"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "secret", "PATH": "C:\\bin"}
    removed = scrub_cloud_keys(environ)
    assert removed == ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    assert environ == {"PATH": "C:\\bin"}
