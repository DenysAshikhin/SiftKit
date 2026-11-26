"""A local OpenAI-compatible endpoint that records each request and answers with fixed content."""

import json
import threading
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pydantic import JsonValue

from local_evals.jsonio import JSON_OBJECT


@dataclass
class Captured:
    path: str
    headers: dict[str, str]
    body: dict[str, JsonValue]


@dataclass
class CaptureServer:
    content: str = "{}"
    requests: list[Captured] = field(default_factory=lambda: [])
    base_url: str = ""

    def chat_requests(self) -> list[Captured]:
        return [request for request in self.requests if request.path.endswith("/chat/completions")]


def _handler(server: CaptureServer) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def do_POST(self) -> None:
            body = JSON_OBJECT.validate_json(self.rfile.read(int(self.headers.get("content-length", "0"))))
            headers = {name.lower(): value for name, value in self.headers.items()}
            server.requests.append(Captured(self.path, headers, body))
            model = str(body.get("model"))
            usage: dict[str, JsonValue] = {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
            if body.get("stream"):
                chunk: dict[str, JsonValue] = {
                    "id": "c1",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": model,
                }
                frames: list[dict[str, JsonValue]] = [
                    {
                        **chunk,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": server.content},
                                "finish_reason": None,
                            }
                        ],
                    },
                    {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    {**chunk, "choices": [], "usage": usage},
                ]
                payload = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
                self._send("text/event-stream", payload.encode("utf-8"))
                return
            message = {"role": "assistant", "content": server.content}
            self._send(
                "application/json",
                json.dumps(
                    {
                        "id": "c1",
                        "object": "chat.completion",
                        "created": 0,
                        "model": model,
                        "usage": usage,
                        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                    }
                ).encode("utf-8"),
            )

        def _send(self, content_type: str, payload: bytes) -> None:
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


@contextmanager
def capture_server(content: str = "{}") -> Generator[CaptureServer, None, None]:
    server = CaptureServer(content=content)
    http_server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(server))
    server.base_url = f"http://127.0.0.1:{http_server.server_address[1]}/bench/v1"
    thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        http_server.shutdown()
        http_server.server_close()
        thread.join(timeout=5)
