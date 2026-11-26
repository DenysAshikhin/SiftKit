import pytest
from pydantic import ValidationError

from local_evals.config import Endpoint
from local_evals.evaluators.base import LiveModel
from local_evals.guard import (
    CloudEndpointError,
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


def test_a_live_model_can_only_point_at_a_loopback_endpoint() -> None:
    # Replaces the old model-string check: the endpoint validates loopback on construction.
    with pytest.raises(ValidationError, match="loopback"):
        LiveModel(
            preset="preset-a",
            endpoint=Endpoint(base_url="https://api.openai.com/v1", api_key_env=None),
            api_key=None,
        )


def test_scrub_removes_cloud_keys_and_reports_their_names_only() -> None:
    environ = {"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "secret", "PATH": "C:\\bin"}
    removed = scrub_cloud_keys(environ)
    assert removed == ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    assert environ == {"PATH": "C:\\bin"}
