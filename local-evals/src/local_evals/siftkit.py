"""Client for SiftKit's /bench/v1 route. The only module that knows its paths and headers."""

import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import TypeVar

import httpx
from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError

from local_evals.config import Endpoint
from local_evals.jsonio import JSON_OBJECT

RESIDENCY_HEADER = "x-siftkit-bench-residency"
GENERATION_HEADER = "x-siftkit-bench-generation"

ModelT = TypeVar("ModelT", bound=BaseModel)


class BenchError(Exception):
    """The bench route was unreachable, or answered with an error or an unexpected shape."""


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ResidentCard(_Wire):
    id: str
    max_seq_len: int
    cache_size: int
    chunk_size: int
    cache_mode: str | None


class RequestedIdentity(_Wire):
    presetId: str
    settings: dict[str, JsonValue]


class ResidentIdentity(_Wire):
    matches: bool
    card: ResidentCard | None


class DraftingIdentity(_Wire):
    configured: bool
    verified: bool | None


class EngineIdentity(_Wire):
    managed: bool
    pythonPath: str
    workingDirectory: str
    entrypoint: str
    environment: dict[str, str]


class ResidencyIdentity(_Wire):
    keyHash: str
    generation: int


class Identity(_Wire):
    """Mirror of BenchIdentityResponseSchema in packages/contracts/src/bench.ts."""

    requested: RequestedIdentity
    resident: ResidentIdentity
    drafting: DraftingIdentity
    engine: EngineIdentity
    residency: ResidencyIdentity


class _Completion(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class ChatUsage(_Completion):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    prompt_time: float | None = None
    prompt_tokens_per_sec: float | None = None
    completion_time: float | None = None
    completion_tokens_per_sec: float | None = None


class ToolFunction(_Completion):
    name: str | None = None
    arguments: str | None = None


class ToolCall(_Completion):
    function: ToolFunction | None = None


class ChatMessage(_Completion):
    content: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] | None = None


class ChatChoice(_Completion):
    finish_reason: str | None = None
    message: ChatMessage | None = None
    delta: ChatMessage | None = None


class ChatCompletion(_Completion):
    choices: list[ChatChoice] = []
    usage: ChatUsage | None = None


def parse_completion(body: dict[str, JsonValue]) -> ChatCompletion:
    """Validates a non-streaming body or one stream frame; the engine may omit any field."""
    try:
        return ChatCompletion.model_validate(body)
    except ValidationError as error:
        raise BenchError(f"Unexpected chat completion shape: {error}") from error


class _ModelEntry(BaseModel):
    id: str


class _ModelList(BaseModel):
    data: list[_ModelEntry]


class _TokenCount(BaseModel):
    length: int


@dataclass(frozen=True)
class ChatResponse:
    status_code: int
    body: dict[str, JsonValue]
    residency: str | None
    generation: int | None


@dataclass(frozen=True)
class StreamFrame:
    # time.perf_counter() when the frame was read.
    received_at: float
    data: dict[str, JsonValue]


def _generation(response: httpx.Response) -> int | None:
    value = response.headers.get(GENERATION_HEADER)
    return int(value) if value is not None and value.isdigit() else None


class BenchClient:
    def __init__(
        self,
        endpoint: Endpoint,
        api_key: str | None,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout_seconds: float = 900.0,
    ) -> None:
        headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.Client(
            base_url=endpoint.base_url, headers=headers, transport=transport, timeout=timeout_seconds
        )

    def _send(self, method: str, path: str, payload: dict[str, JsonValue] | None) -> httpx.Response:
        try:
            return self._http.request(method, path, json=payload)
        except httpx.HTTPError as error:
            raise BenchError(f"Cannot reach {self._http.base_url}{path}: {error}") from error

    def _body(self, response: httpx.Response) -> dict[str, JsonValue]:
        try:
            return JSON_OBJECT.validate_json(response.content)
        except ValidationError as error:
            message = (
                f"answered HTTP {response.status_code} with a body that is not JSON."
                if error.errors()[0]["type"] == "json_invalid"
                else "answered with JSON that is not an object."
            )
            raise BenchError(f"{response.request.url} {message}") from error

    def _ok(self, response: httpx.Response) -> dict[str, JsonValue]:
        body = self._body(response)
        if response.status_code != 200:
            raise BenchError(
                f"{response.request.url} answered HTTP {response.status_code}: {body.get('error', body)}"
            )
        return body

    def _parsed(self, response: httpx.Response, model: type[ModelT], what: str) -> ModelT:
        body = self._ok(response)
        try:
            return model.model_validate(body)
        except ValidationError as error:
            raise BenchError(f"Unexpected {what} shape: {error}") from error

    def list_models(self) -> list[str]:
        listing = self._parsed(self._send("GET", "/models", None), _ModelList, "model list")
        return [entry.id for entry in listing.data]

    def identity(self, model: str) -> Identity:
        return self._parsed(self._send("POST", "/identity", {"model": model}), Identity, "identity")

    def count_tokens(
        self,
        model: str,
        text: str | list[JsonValue],
        chat_template_kwargs: dict[str, JsonValue] | None = None,
    ) -> int:
        """Token count of plain text, or of chat messages rendered through the model's template."""
        payload: dict[str, JsonValue] = {"model": model, "text": text}
        if chat_template_kwargs is not None:
            payload["chat_template_kwargs"] = chat_template_kwargs
        return self._parsed(self._send("POST", "/token/encode", payload), _TokenCount, "token count").length

    def chat(self, payload: dict[str, JsonValue]) -> ChatResponse:
        """One non-streaming chat. An HTTP error status is returned, not raised: it is a measured outcome."""
        response = self._send("POST", "/chat/completions", payload)
        return ChatResponse(
            response.status_code,
            self._body(response),
            response.headers.get(RESIDENCY_HEADER),
            _generation(response),
        )

    def stream_chat(self, payload: dict[str, JsonValue]) -> Iterator[StreamFrame]:
        """Streams one chat with the final usage frame requested; raises BenchError on a non-200 status."""
        request: dict[str, JsonValue] = {**payload, "stream": True, "stream_options": {"include_usage": True}}
        try:
            with self._http.stream("POST", "/chat/completions", json=request) as response:
                if response.status_code != 200:
                    response.read()
                    raise BenchError(
                        f"Streaming chat answered HTTP {response.status_code}: {response.text[:500]}"
                    )
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        frame = JSON_OBJECT.validate_json(data)
                    except ValidationError as error:
                        raise BenchError(
                            f"Streaming chat sent a frame that is not a JSON object: {data[:200]}"
                        ) from error
                    yield StreamFrame(time.perf_counter(), frame)
        except httpx.HTTPError as error:
            raise BenchError(f"Streaming chat failed: {error}") from error
