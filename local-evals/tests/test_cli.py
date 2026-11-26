import json
from pathlib import Path

import pytest

from local_evals import cli
from local_evals.cli import main
from local_evals.evaluators.base import RawLogRef, TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.paths import PROJECT_ROOT

CONFIGS = str(PROJECT_ROOT / "configs")


class NoisyEvaluator(InspectEvaluator):
    """Stands in for a library that prints progress to stdout while running a task."""

    def run(self, request: TaskRunRequest) -> RawLogRef:
        print("noise from a library")
        return super().run(request)


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(["--config-dir", CONFIGS, *argv])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_list_tasks_prints_the_catalogue(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, "--json", "list-tasks")
    assert code == 0
    assert [task["id"] for task in json.loads(out)] == [
        "inspect_evals/gsm8k",
        "local_evals/structured_output",
    ]


def test_dry_run_prints_planned_work_and_contacts_nothing(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code, out, _ = run(
        capsys,
        "--runs-dir",
        str(tmp_path),
        "--json",
        "run",
        "--suite",
        "smoke",
        "--model",
        "exl3-3-8-27b-5bpw",
        "--dry-run",
    )
    plan = json.loads(out)
    assert code == 0
    assert plan["model"] == "exl3-3-8-27b-5bpw" and plan["endpoint"] == "http://127.0.0.1:4765/bench/v1"
    assert [task["task"] for task in plan["tasks"]] == [
        "inspect_evals/gsm8k",
        "local_evals/structured_output",
    ]
    assert plan["tasks"][0]["dataset"] == "openai/gsm8k" and plan["tasks"][0]["sandbox"] is False
    assert len(plan["manifest_digest"]) == 64
    assert list(tmp_path.iterdir()) == [], "a dry run writes nothing"


def test_mock_run_then_report_round_trip(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    code, out, _ = run(
        capsys,
        "--runs-dir",
        str(tmp_path),
        "--json",
        "run",
        "--suite",
        "structured",
        "--model",
        "exl3-3-8-27b-5bpw",
        "--mock",
    )
    assert code == 0
    run_id = json.loads(out)["run_id"]
    assert (tmp_path / run_id / "report.md").read_text(encoding="utf-8").count("MOCKED RUN") == 1
    assert (tmp_path / run_id / "summary.json").is_file()

    code, out, _ = run(capsys, "--runs-dir", str(tmp_path), "report", "--run-id", run_id, "--format", "csv")
    assert code == 0 and out.splitlines()[1].startswith("local_evals/structured_output,6,6,0.0,0.0,0,")


def test_library_stdout_noise_keeps_json_output_clean(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "InspectEvaluator", NoisyEvaluator)
    code, out, err = run(
        capsys,
        "--runs-dir",
        str(tmp_path),
        "--json",
        "run",
        "--suite",
        "structured",
        "--model",
        "preset-a",
        "--mock",
    )
    assert code == 0
    assert json.loads(out)["run_id"]
    assert "noise from a library" in err
    assert "noise from a library" not in out


def test_dataset_suite_fails_fast_without_download_flag(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code, out, err = run(
        capsys, "--runs-dir", str(tmp_path), "run", "--suite", "smoke", "--model", "preset-a", "--mock"
    )
    assert code == 2
    assert out == ""
    assert (
        "error: inspect_evals/gsm8k load Hugging Face dataset(s) openai/gsm8k; re-run with "
        "--allow-dataset-download to permit access to huggingface.co." in err
    )
    assert "inspect_evals/gsm8k" in err and "openai/gsm8k" in err and "--allow-dataset-download" in err
    assert list(tmp_path.iterdir()) == [], "no run directory is created"


def test_dry_run_of_dataset_suite_still_prints_the_plan(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code, out, _ = run(
        capsys,
        "--runs-dir",
        str(tmp_path),
        "--json",
        "run",
        "--suite",
        "smoke",
        "--model",
        "preset-a",
        "--dry-run",
    )
    assert code == 0
    plan = json.loads(out)
    assert [task["task"] for task in plan["tasks"]] == [
        "inspect_evals/gsm8k",
        "local_evals/structured_output",
    ]
    assert list(tmp_path.iterdir()) == []


def test_config_and_endpoint_errors_exit_two_with_one_line(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code, _, err = run(capsys, "run", "--suite", "no-such-suite", "--model", "m", "--dry-run")
    assert code == 2 and err.startswith("error: ") and "no-such-suite" in err

    code, _, err = run(capsys, "--runs-dir", str(tmp_path), "report", "--run-id", "missing")
    assert code == 2 and "missing" in err

    # Nothing listens on the discard port, so the endpoint is unreachable.
    configs = tmp_path / "configs"
    configs.mkdir()
    (configs / "models.yaml").write_text(
        "endpoints:\n  dead:\n    base_url: http://127.0.0.1:9/bench/v1\n    api_key_env: null\nmodels: {}\n",
        encoding="utf-8",
    )
    assert main(["--config-dir", str(configs), "list-models", "--endpoint", "dead"]) == 2
    assert "Cannot reach" in capsys.readouterr().err
