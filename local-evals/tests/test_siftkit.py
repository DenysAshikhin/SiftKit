import httpx
import pytest

from local_evals.config import Endpoint
from local_evals.siftkit import BenchClient, BenchError, parse_completion
from tests.fake_bench import RESIDENCY, USAGE, FakeBench

ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)


def client_for(fake: FakeBench, api_key: str | None = None) -> BenchClient:
    return BenchClient(ENDPOINT, api_key, transport=fake.transport())


def test_models_identity_and_token_count() -> None:
    fake = FakeBench(models=["preset-a", "preset-b"])
    client = client_for(fake, api_key="secret")

    assert client.list_models() == ["preset-a", "preset-b"]
    identity = client.identity("preset-a")
    assert identity.resident.matches is True
    assert identity.resident.card is not None and identity.resident.card.cache_mode == "8,8"
    assert identity.residency.keyHash == RESIDENCY
    assert client.identity("preset-b").resident.card is None
    assert client.count_tokens("preset-a", "abcdefgh") == 2
    assert all(request.url.path.startswith("/bench/v1/") for request in fake.requests)
    assert fake.requests[0].headers["authorization"] == "Bearer secret"


def test_chat_returns_status_body_and_residency_without_raising() -> None:
    client = client_for(FakeBench(generation=7))
    ok = client.chat({"model": "preset-a", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    assert (ok.status_code, ok.residency, ok.generation) == (200, RESIDENCY, 7)
    assert ok.body["choices"] is not None

    rejected = client_for(FakeBench(chat_status=400)).chat(
        {"model": "preset-a", "messages": [], "max_tokens": 8}
    )
    assert rejected.status_code == 400
    assert rejected.body == {"detail": "fake engine rejected the request"}
    assert rejected.residency is None


def test_parse_completion_exposes_message_finish_and_usage() -> None:
    response = client_for(FakeBench()).chat(
        {"model": "preset-a", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8}
    )
    completion = parse_completion(response.body)
    choice = completion.choices[0]
    assert choice.message is not None
    assert choice.message.content == "alpha"
    assert choice.finish_reason == "stop"
    assert completion.usage is not None
    assert completion.usage.completion_tokens_per_sec == 50.0


def test_parse_completion_exposes_a_usage_only_stream_frame() -> None:
    completion = parse_completion({"choices": [], "usage": USAGE})
    assert completion.choices == []
    assert completion.usage is not None
    assert completion.usage.completion_tokens == 5
    assert completion.usage.completion_tokens_per_sec == 50.0


def test_parse_completion_rejects_an_unexpected_shape() -> None:
    with pytest.raises(BenchError, match="chat completion shape"):
        parse_completion({"choices": "nope"})


def test_stream_yields_timestamped_frames_and_asks_for_usage() -> None:
    fake = FakeBench()
    frames = list(client_for(fake).stream_chat({"model": "preset-a", "messages": [], "max_tokens": 8}))
    assert [frame.data.get("usage") is not None for frame in frames] == [False, False, False, True]
    assert all(
        later.received_at >= earlier.received_at for earlier, later in zip(frames, frames[1:], strict=False)
    )
    sent = fake.bodies("/chat/completions")[0]
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


def test_failures_are_bench_errors_with_the_cause() -> None:
    with pytest.raises(BenchError, match="does not exist"):
        client_for(FakeBench()).identity("missing")

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    unreachable = BenchClient(ENDPOINT, None, transport=httpx.MockTransport(refuse))
    with pytest.raises(BenchError, match="Cannot reach"):
        unreachable.list_models()

    def not_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>")

    with pytest.raises(BenchError, match="not JSON"):
        BenchClient(ENDPOINT, None, transport=httpx.MockTransport(not_json)).list_models()


def test_array_body_is_a_bench_error() -> None:
    def array_body(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    with pytest.raises(BenchError):
        BenchClient(ENDPOINT, None, transport=httpx.MockTransport(array_body)).list_models()


def test_streaming_chat_http_error_is_a_bench_error() -> None:
    def server_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="fake engine failed")

    with pytest.raises(BenchError, match="HTTP 500"):
        list(
            BenchClient(ENDPOINT, None, transport=httpx.MockTransport(server_error)).stream_chat(
                {"model": "preset-a"}
            )
        )


def test_malformed_stream_frame_is_a_bench_error() -> None:
    def broken_stream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=b"data: {broken\n\ndata: [DONE]\n\n"
        )

    with pytest.raises(BenchError, match="frame"):
        list(
            BenchClient(ENDPOINT, None, transport=httpx.MockTransport(broken_stream)).stream_chat(
                {"model": "preset-a"}
            )
        )


def test_non_object_stream_frame_is_a_bench_error() -> None:
    def list_stream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=b"data: [1]\n\ndata: [DONE]\n\n"
        )

    with pytest.raises(BenchError, match="frame"):
        list(
            BenchClient(ENDPOINT, None, transport=httpx.MockTransport(list_stream)).stream_chat(
                {"model": "preset-a"}
            )
        )
