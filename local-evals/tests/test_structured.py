import json
from pathlib import Path

import pytest

from local_evals.paths import FIXTURES
from local_evals.tasks.structured import StructuredCase, load_cases, render_prompt, score_structured

CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
ORDER = CASES[0]


def test_fixture_loads_with_stable_ids_and_self_consistent_answers() -> None:
    assert [case.id for case in CASES] == ["so-001", "so-002", "so-003", "so-004", "so-005", "so-006"]
    for case in CASES:
        assert score_structured(json.dumps(case.expected), case).value == 1.0


def test_exact_object_scores_correct_and_wrong_values_score_incorrect() -> None:
    assert score_structured(f"  {json.dumps(ORDER.expected)}\n", ORDER).status == "correct"
    wrong = {**ORDER.expected, "shipping": "standard"}
    result = score_structured(json.dumps(wrong), ORDER)
    assert (result.value, result.status) == (0.0, "incorrect")


@pytest.mark.parametrize(
    "output",
    [
        "Here is the JSON: {}",
        '```json\n{"order_id": 4417}\n```',
        "[1, 2, 3]",
        "{not json",
        '{"order_id": "4417", "customer": "Dana Reyes", "items": [], "shipping": "express"}',
        '{"order_id": 4417, "customer": "Dana Reyes", "items": [], "shipping": "overnight"}',
        '{"order_id": 4417, "customer": "Dana Reyes", "items": [], "shipping": "express", "note": "x"}',
        "",
    ],
)
def test_anything_but_one_schema_valid_object_is_invalid_format(output: str) -> None:
    result = score_structured(output, ORDER)
    assert (result.value, result.status) == (0.0, "invalid_format")
    assert result.explanation


def test_numeric_equality_ignores_integer_versus_float_spelling() -> None:
    assert score_structured('{"readings": [21.5, 22, 20.5], "sum": 64}', CASES[5]).status == "correct"


def test_prompt_contains_the_schema_and_the_instruction() -> None:
    prompt = render_prompt(ORDER)
    assert "only a JSON object" in prompt
    assert '"order_id"' in prompt and ORDER.prompt in prompt


def test_a_malformed_fixture_line_is_reported_with_its_line_number(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text(
        '{"id": "x", "prompt": "p", "schema": {}, "expected": {}, "tags": []}\n{"id": "y"}\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="line 2"):
        load_cases(bad)


def test_a_case_survives_a_dump_and_reload() -> None:
    assert StructuredCase.model_validate(ORDER.model_dump()) == ORDER


def test_a_malformed_fixture_line_names_its_line(tmp_path: Path) -> None:
    bad = tmp_path / "broken.jsonl"
    bad.write_text(
        '{"id": "x", "tags": [], "prompt": "p", "schema": {}, "expected": {}}\n{broken\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="line 2"):
        load_cases(bad)
