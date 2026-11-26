from local_evals.config import Endpoint
from local_evals.doctor import Check, check_overflow, has_failure, run_doctor
from local_evals.siftkit import BenchClient
from tests.fake_bench import FakeBench

ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)


def doctor(fake: FakeBench, model: str = "preset-a") -> dict[str, Check]:
    client = BenchClient(ENDPOINT, None, transport=fake.transport())
    return {check.name: check for check in run_doctor(client, model)}


def test_a_healthy_endpoint_passes_every_capability_check() -> None:
    checks = doctor(FakeBench())
    expected_ok = {
        "models",
        "chat",
        "backend_timing",
        "residency_headers",
        "streaming",
        "reasoning",
        "seed",
        "stop",
        "native_tools",
        "identity",
        "kv_cache_verified",
    }
    assert {name for name, check in checks.items() if check.status == "ok"} >= expected_ok
    assert checks["drafting_verified"].status == "unsupported"
    assert checks["sandbox"].status in ("ok", "unsupported")
    assert has_failure(list(checks.values())) is False


def test_unsupported_capabilities_are_reported_not_assumed() -> None:
    checks = doctor(
        FakeBench(seed_honoured=False, reasoning=False, tools=False, backend_timing=False, cache_mode=None)
    )
    for name in ("seed", "reasoning", "native_tools", "backend_timing", "kv_cache_verified"):
        assert checks[name].status == "unsupported", name
    assert "emulate_tools" in checks["native_tools"].detail
    assert has_failure(list(checks.values())) is False


def test_wrong_model_id_stops_after_the_models_check() -> None:
    checks = doctor(FakeBench(), model="not-a-preset")
    assert list(checks) == ["models"]
    assert checks["models"].status == "fail" and "preset-a" in checks["models"].detail
    assert has_failure(list(checks.values())) is True


def test_failed_chat_and_identity_mismatch_are_failures() -> None:
    rejected = doctor(FakeBench(chat_status=500))
    assert rejected["chat"].status == "fail" and "500" in rejected["chat"].detail
    assert "streaming" not in rejected

    assert doctor(FakeBench(resident=None))["identity"].status == "fail"


def test_overflow_check_passes_only_when_the_engine_rejects_an_oversized_prompt() -> None:
    rejecting = BenchClient(ENDPOINT, None, transport=FakeBench(chat_status=400).transport())
    assert check_overflow(rejecting, "preset-a", context_tokens=64).status == "ok"
    accepting = BenchClient(ENDPOINT, None, transport=FakeBench().transport())
    assert check_overflow(accepting, "preset-a", context_tokens=64).status == "fail"


def test_overflow_check_fails_when_the_engine_errors_instead_of_rejecting() -> None:
    failing = BenchClient(ENDPOINT, None, transport=FakeBench(chat_status=502).transport())
    result = check_overflow(failing, "preset-a", context_tokens=64)
    assert result.status == "fail"
    assert "engine failed" in result.detail


def test_overflow_probe_is_smaller_than_a_full_context_of_the_phrase() -> None:
    fake = FakeBench(chat_status=400)
    client = BenchClient(ENDPOINT, None, transport=fake.transport())
    assert check_overflow(client, "preset-a", context_tokens=64).status == "ok"
    (probe,) = fake.bodies("/chat/completions")
    messages = probe["messages"]
    assert isinstance(messages, list) and len(messages) == 1
    (message,) = messages
    content = message.get("content") if isinstance(message, dict) else None
    assert isinstance(content, str)
    assert len(content) < len("lorem ipsum dolor sit amet " * 64)
