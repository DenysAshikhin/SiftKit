"""Preflight. Each check reports ok, fail, unsupported or skipped; nothing is assumed to work."""

import math
import shutil
from dataclasses import dataclass
from typing import Literal

from pydantic import JsonValue, ValidationError

from local_evals.jsonio import JSON_OBJECT
from local_evals.siftkit import (
    BenchClient,
    ChatCompletion,
    ChatMessage,
    ChatResponse,
    parse_completion,
)

CheckStatus = Literal["ok", "fail", "unsupported", "skipped"]
BACKEND_TIMING_FIELDS = (
    "prompt_time",
    "prompt_tokens_per_sec",
    "completion_time",
    "completion_tokens_per_sec",
)
WEATHER_TOOL: dict[str, JsonValue] = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Returns the current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
OVERFLOW_PHRASE = "lorem ipsum dolor sit amet "
OVERFLOW_SAMPLE_REPEATS = 1000
OVERFLOW_HEADROOM = 1.1


@dataclass(frozen=True)
class Check:
    name: str
    status: CheckStatus
    detail: str


def has_failure(checks: list[Check]) -> bool:
    return any(check.status == "fail" for check in checks)


def _probe(model: str, content: str, **extra: JsonValue) -> dict[str, JsonValue]:
    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 32,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
        **extra,
    }


def _first_message(completion: ChatCompletion) -> ChatMessage | None:
    choice = completion.choices[0] if completion.choices else None
    return choice.message if choice is not None else None


def _content(body: dict[str, JsonValue]) -> str | None:
    message = _first_message(parse_completion(body))
    return message.content if message is not None else None


def check_models(client: BenchClient, model: str) -> Check:
    models = client.list_models()
    if model in models:
        return Check("models", "ok", f"{len(models)} preset(s) listed.")
    return Check("models", "fail", f"Preset {model!r} is not served; available: {', '.join(models)}")


def check_chat(response: ChatResponse) -> Check:
    if response.status_code != 200:
        return Check("chat", "fail", f"HTTP {response.status_code}: {response.body}")
    completion = parse_completion(response.body)
    choice = completion.choices[0] if completion.choices else None
    finish = choice.finish_reason if choice is not None else None
    usage = completion.usage
    if finish not in ("stop", "length"):
        return Check("chat", "fail", f"Unexpected finish_reason {finish!r}.")
    if usage is None or usage.prompt_tokens is None or usage.completion_tokens is None:
        return Check("chat", "fail", "The response has no usage token counts.")
    return Check("chat", "ok", f"finish_reason {finish}, {usage.prompt_tokens} prompt tokens.")


def check_backend_timing(response: ChatResponse) -> Check:
    usage = parse_completion(response.body).usage
    values = (
        (
            usage.prompt_time,
            usage.prompt_tokens_per_sec,
            usage.completion_time,
            usage.completion_tokens_per_sec,
        )
        if usage is not None
        else (None, None, None, None)
    )
    missing = [name for name, value in zip(BACKEND_TIMING_FIELDS, values, strict=True) if value is None]
    if missing:
        return Check(
            "backend_timing",
            "unsupported",
            f"usage lacks {', '.join(missing)}; prefill and decode rates will be null.",
        )
    return Check("backend_timing", "ok", "usage carries backend prefill and decode timing.")


def check_residency_headers(response: ChatResponse) -> Check:
    if response.residency is None or response.generation is None:
        return Check("residency_headers", "fail", "The route returned no residency or generation header.")
    return Check(
        "residency_headers", "ok", f"residency {response.residency}, generation {response.generation}."
    )


def check_streaming(client: BenchClient, model: str) -> Check:
    delta_frames = 0
    usage_frame = False
    for frame in client.stream_chat(_probe(model, "Reply with the single word: alpha")):
        completion = parse_completion(frame.data)
        if completion.usage is not None:
            usage_frame = True
        choice = completion.choices[0] if completion.choices else None
        delta = choice.delta if choice is not None else None
        if delta is not None and (delta.content is not None or delta.tool_calls is not None):
            delta_frames += 1
    if delta_frames == 0:
        return Check("streaming", "fail", "The stream carried no content delta.")
    if not usage_frame:
        return Check(
            "streaming",
            "unsupported",
            "The stream carried no final usage frame; streamed token counts will be null.",
        )
    return Check("streaming", "ok", f"{delta_frames} delta frame(s) and a usage frame.")


def check_reasoning(client: BenchClient, model: str) -> Check:
    response = client.chat(
        _probe(
            model,
            "What is 17 + 26? Answer with the number only.",
            max_tokens=512,
            chat_template_kwargs={"enable_thinking": True},
        )
    )
    if response.status_code != 200:
        return Check("reasoning", "fail", f"HTTP {response.status_code} with thinking enabled.")
    message = _first_message(parse_completion(response.body))
    if message is not None and message.reasoning_content is not None:
        return Check("reasoning", "ok", "reasoning_content is returned separately from content.")
    return Check(
        "reasoning",
        "unsupported",
        "No reasoning_content field; reasoning text cannot be separated from the answer.",
    )


def check_seed(client: BenchClient, model: str) -> Check:
    request = _probe(model, "Write one random six-letter word.", temperature=1.0, seed=1234)
    first, second = client.chat(request), client.chat(request)
    if first.status_code != 200 or second.status_code != 200:
        return Check("seed", "fail", f"HTTP {first.status_code}/{second.status_code} with a seed set.")
    if _content(first.body) == _content(second.body):
        return Check("seed", "ok", "Two seeded requests returned identical text.")
    return Check("seed", "unsupported", "Two seeded requests differed; use repeats, not seeds, for variance.")


def check_stop(client: BenchClient, model: str) -> Check:
    response = client.chat(_probe(model, "Repeat exactly: red green blue yellow", stop=["blue"]))
    content = _content(response.body)
    if response.status_code != 200 or content is None:
        return Check("stop", "fail", f"HTTP {response.status_code} with a stop sequence.")
    if "blue" in content:
        return Check("stop", "unsupported", "The stop sequence appeared in the output.")
    return Check("stop", "ok", "Output ended before the stop sequence.")


def check_native_tools(client: BenchClient, model: str) -> Check:
    response = client.chat(
        _probe(model, "What is the weather in Oslo? Call the tool.", max_tokens=256, tools=[WEATHER_TOOL])
    )
    message = _first_message(parse_completion(response.body))
    calls = message.tool_calls if message is not None else None
    fallback = "run tool tasks with emulate_tools as a separately labelled condition."
    if response.status_code != 200 or not calls:
        return Check("native_tools", "unsupported", f"No native tool call was returned; {fallback}")
    function = calls[0].function
    if function is None or function.arguments is None:
        return Check("native_tools", "unsupported", f"Tool arguments were not valid JSON; {fallback}")
    try:
        parsed = JSON_OBJECT.validate_json(function.arguments)
    except ValidationError:
        return Check("native_tools", "unsupported", f"Tool arguments were not valid JSON; {fallback}")
    if function.name != "get_weather" or "city" not in parsed:
        return Check("native_tools", "unsupported", f"The tool call did not match the schema; {fallback}")
    return Check("native_tools", "ok", "A native tool call with schema-valid arguments was returned.")


def check_identity(client: BenchClient, model: str) -> list[Check]:
    identity = client.identity(model)
    card = identity.resident.card
    if not identity.resident.matches or card is None:
        return [Check("identity", "fail", "The resident model does not match the preset.")]
    kv = (
        Check("kv_cache_verified", "ok", f"Applied cache mode {card.cache_mode}.")
        if card.cache_mode is not None
        else Check(
            "kv_cache_verified",
            "unsupported",
            "The model card reports no cache mode; KV precision is as configured only.",
        )
    )
    drafting = (
        Check("drafting_verified", "ok", "Drafting was confirmed at load.")
        if identity.drafting.verified
        else Check(
            "drafting_verified",
            "unsupported",
            f"Drafting configured {identity.drafting.configured}; not verifiable.",
        )
    )
    return [
        Check("identity", "ok", f"{card.id}, context {card.max_seq_len}, chunk {card.chunk_size}."),
        kv,
        drafting,
    ]


def check_sandbox() -> Check:
    if shutil.which("docker") is None:
        return Check(
            "sandbox",
            "unsupported",
            "Docker is not installed; tasks that execute model output are unavailable.",
        )
    return Check("sandbox", "ok", "docker is on PATH.")


def check_overflow(client: BenchClient, model: str, context_tokens: int) -> Check:
    """Sends a prompt larger than the context and requires the engine to reject it rather than truncate."""
    per_repeat = (
        client.count_tokens(model, OVERFLOW_PHRASE * OVERFLOW_SAMPLE_REPEATS) / OVERFLOW_SAMPLE_REPEATS
    )
    text = OVERFLOW_PHRASE * math.ceil(OVERFLOW_HEADROOM * context_tokens / per_repeat)
    measured = client.count_tokens(model, text)
    if measured <= context_tokens:
        return Check("overflow", "skipped", f"The probe prompt is only {measured} tokens.")
    response = client.chat(_probe(model, text))
    if response.status_code >= 500:
        return Check(
            "overflow",
            "fail",
            f"HTTP {response.status_code} for a {measured}-token prompt: "
            "the engine failed instead of rejecting it.",
        )
    if 400 <= response.status_code < 500:
        return Check(
            "overflow",
            "ok",
            f"HTTP {response.status_code} for a {measured}-token prompt: {str(response.body)[:200]}",
        )
    return Check(
        "overflow", "fail", f"A {measured}-token prompt was accepted by a {context_tokens}-token context."
    )


def run_doctor(client: BenchClient, model: str) -> list[Check]:
    checks = [check_models(client, model)]
    if has_failure(checks):
        return checks
    first = client.chat(_probe(model, "Reply with the single word: alpha"))
    checks.append(check_chat(first))
    if has_failure(checks):
        return checks
    checks.append(check_backend_timing(first))
    checks.append(check_residency_headers(first))
    checks.append(check_streaming(client, model))
    checks.append(check_reasoning(client, model))
    checks.append(check_seed(client, model))
    checks.append(check_stop(client, model))
    checks.append(check_native_tools(client, model))
    checks.extend(check_identity(client, model))
    checks.append(check_sandbox())
    return checks
