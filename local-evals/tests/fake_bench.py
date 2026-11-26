"""In-process stand-in for the SiftKit bench route, served through httpx.MockTransport."""

import json
from dataclasses import dataclass, field

import httpx
from pydantic import JsonValue

from local_evals.jsonio import JSON_OBJECT
from local_evals.siftkit import GENERATION_HEADER, RESIDENCY_HEADER

RESIDENCY = "0123456789abcdef"

USAGE: dict[str, JsonValue] = {
    "prompt_tokens": 12,
    "completion_tokens": 5,
    "total_tokens": 17,
    "prompt_time": 0.01,
    "prompt_tokens_per_sec": 1200.0,
    "completion_time": 0.1,
    "completion_tokens_per_sec": 50.0,
    "prompt_tokens_details": {"cached_tokens": 0},
}


@dataclass
class FakeBench:
    models: list[str] = field(default_factory=lambda: ["preset-a"])
    resident: str | None = "preset-a"
    cache_mode: str | None = "8,8"
    seed_honoured: bool = True
    reasoning: bool = True
    tools: bool = True
    backend_timing: bool = True
    generation: int = 3
    chat_status: int = 200
    requests: list[httpx.Request] = field(default_factory=lambda: [])
    seeded_calls: int = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def bodies(self, suffix: str) -> list[dict[str, JsonValue]]:
        return [
            JSON_OBJECT.validate_json(request.content)
            for request in self.requests
            if request.url.path.endswith(suffix)
        ]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET" and path.endswith("/models"):
            data = [{"id": model, "object": "model"} for model in self.models]
            return httpx.Response(200, json={"object": "list", "data": data})
        body: dict[str, JsonValue] = JSON_OBJECT.validate_json(request.content) if request.content else {}
        if path.endswith("/identity"):
            return self._identity(body)
        if path.endswith("/token/encode"):
            return httpx.Response(200, json={"length": max(1, len(str(body["text"])) // 4)})
        if path.endswith("/chat/completions"):
            return self._chat(body)
        return httpx.Response(404, json={"error": "Not found"})

    def _identity(self, body: dict[str, JsonValue]) -> httpx.Response:
        model = str(body["model"])
        if model not in self.models:
            return httpx.Response(400, json={"error": f"Model preset '{model}' does not exist."})
        matches = self.resident == model
        card: dict[str, JsonValue] = {
            "id": "served-model",
            "max_seq_len": 32000,
            "cache_size": 32000,
            "chunk_size": 2048,
            "cache_mode": self.cache_mode,
        }
        settings: dict[str, JsonValue] = {
            "id": model,
            "NumCtx": 32000,
            "KvCacheQuantization": "q8_0",
            "SpeculativeEnabled": False,
            "ModelPath": "C:\\models\\served-model",
        }
        payload: dict[str, JsonValue] = {
            "requested": {"presetId": model, "settings": settings},
            "resident": {"matches": matches, "card": card if matches else None},
            "drafting": {"configured": False, "verified": None},
            "engine": {
                "managed": True,
                "pythonPath": "C:\\engine\\venv\\Scripts\\python.exe",
                "workingDirectory": "C:\\engine\\tabby",
                "entrypoint": "main.py",
                "environment": {},
            },
            "residency": {"keyHash": RESIDENCY, "generation": self.generation},
        }
        return httpx.Response(200, json=payload)

    def _chat(self, body: dict[str, JsonValue]) -> httpx.Response:
        if self.chat_status != 200:
            return httpx.Response(self.chat_status, json={"detail": "fake engine rejected the request"})
        headers = {RESIDENCY_HEADER: RESIDENCY, GENERATION_HEADER: str(self.generation)}
        usage = (
            USAGE
            if self.backend_timing
            else {key: USAGE[key] for key in ("prompt_tokens", "completion_tokens")}
        )
        if body.get("stream"):
            frames: list[dict[str, JsonValue]] = [
                {"choices": [{"delta": {"content": "al"}}]},
                {"choices": [{"delta": {"content": "pha"}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                {"choices": [], "usage": usage},
            ]
            text = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
            return httpx.Response(
                200, headers={**headers, "content-type": "text/event-stream"}, content=text.encode("utf-8")
            )
        message: dict[str, JsonValue] = {"role": "assistant", "content": self._content(body)}
        finish_reason = "stop"
        call = self._tool_call(body)
        if call is not None:
            message = {"role": "assistant", "content": None, "tool_calls": [call]}
            finish_reason = "tool_calls"
        kwargs = body.get("chat_template_kwargs")
        if isinstance(kwargs, dict) and kwargs.get("enable_thinking") and self.reasoning:
            message["reasoning_content"] = "thinking"
        payload: dict[str, JsonValue] = {
            "choices": [{"message": message, "finish_reason": finish_reason}],
            "usage": usage,
        }
        return httpx.Response(200, headers=headers, json=payload)

    def _tool_call(self, body: dict[str, JsonValue]) -> dict[str, JsonValue] | None:
        """The first requested tool echoed as a call, or None when tools are off or the body is malformed."""
        tools = body.get("tools")
        if not self.tools or not isinstance(tools, list) or not tools:
            return None
        first = tools[0]
        function = first.get("function") if isinstance(first, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            return None
        return {
            "id": "call_1",
            "type": "function",
            "function": {"name": function["name"], "arguments": '{"city": "Oslo"}'},
        }

    def _content(self, body: dict[str, JsonValue]) -> str:
        if "seed" in body and not self.seed_honoured:
            self.seeded_calls += 1
            return f"draw {self.seeded_calls}"
        return "alpha"
