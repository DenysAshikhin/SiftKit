"""Shared JSON object validation for machine-written run artifacts."""

from pydantic import JsonValue, TypeAdapter

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
