"""Structured-output task: the model must return exactly one JSON object that validates and matches."""

import json
from dataclasses import dataclass
from pathlib import Path

from jsonschema import Draft202012Validator, validate
from jsonschema.exceptions import ValidationError as JsonSchemaError
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from local_evals.jsonio import JSON_OBJECT
from local_evals.records import SampleStatus

DEFAULT_FIXTURE = "structured/v1.jsonl"

INSTRUCTION = (
    "Respond with only a JSON object that validates against the JSON Schema below. "
    "No prose, no code fences, no keys the schema does not define."
)


class StructuredCase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str
    tags: list[str]
    prompt: str
    # The attribute is schema_ because schema shadows a BaseModel attribute; the fixture key is schema.
    schema_: dict[str, JsonValue] = Field(alias="schema")
    expected: dict[str, JsonValue]


@dataclass(frozen=True)
class TaskScore:
    value: float
    status: SampleStatus
    explanation: str


def load_cases(path: Path) -> list[StructuredCase]:
    cases: list[StructuredCase] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            cases.append(StructuredCase.model_validate_json(line))
        except ValidationError as error:
            raise ValueError(f"{path} line {number}: {error}") from error
    return cases


def render_prompt(case: StructuredCase) -> str:
    return f"{INSTRUCTION}\n\nSchema:\n{json.dumps(case.schema_, indent=2)}\n\nTask:\n{case.prompt}"


def score_structured(output: str, case: StructuredCase) -> TaskScore:
    try:
        parsed = JSON_OBJECT.validate_json(output.strip())
    except ValidationError:
        return TaskScore(0.0, "invalid_format", "Output is not a single JSON object.")
    try:
        validate(parsed, case.schema_, cls=Draft202012Validator)
    except JsonSchemaError as error:
        return TaskScore(0.0, "invalid_format", f"Schema violation: {error.message}")
    if parsed == case.expected:
        return TaskScore(1.0, "correct", "Matches the expected object.")
    return TaskScore(0.0, "incorrect", "Schema-valid, but the values differ from the expected object.")
