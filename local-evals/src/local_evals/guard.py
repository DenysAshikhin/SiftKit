"""Keeps every model call on this machine."""

from collections.abc import MutableMapping
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

# Inference-provider credentials an evaluator could otherwise pick up and bill against.
CLOUD_KEY_VARS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)


class CloudEndpointError(Exception):
    """A model or endpoint that is not on this machine was requested."""


def assert_loopback(url: str) -> None:
    if urlsplit(url).hostname not in LOOPBACK_HOSTS:
        raise CloudEndpointError(
            f"Endpoint {url!r} is not a loopback address; remote endpoints are not supported."
        )


def assert_local_model(model: str, provider: str) -> None:
    if model.startswith("mockllm/") or model.startswith(f"openai-api/{provider}/"):
        return
    raise CloudEndpointError(f"Model {model!r} is not served by the local '{provider}' endpoint.")


def scrub_cloud_keys(environ: MutableMapping[str, str]) -> list[str]:
    """Removes cloud credentials from `environ` and returns the names removed, never the values."""
    removed = [name for name in CLOUD_KEY_VARS if name in environ]
    for name in removed:
        del environ[name]
    return removed
