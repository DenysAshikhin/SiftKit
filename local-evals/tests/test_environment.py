import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

import local_evals.environment as environment
from local_evals.environment import (
    Environment,
    GitState,
    Gpu,
    Unavailable,
    collect_environment,
    exllamav3_version,
    git_state,
)
from local_evals.paths import REPO_ROOT
from local_evals.siftkit import Identity


def test_exllamav3_version_is_read_from_site_packages_without_running_the_interpreter(tmp_path: Path) -> None:
    python = tmp_path / "venv" / "Scripts" / "python.exe"
    (tmp_path / "venv" / "Lib" / "site-packages" / "exllamav3-1.6.5.dist-info").mkdir(parents=True)
    assert exllamav3_version(python) == "1.6.5"
    missing = exllamav3_version(tmp_path / "elsewhere" / "Scripts" / "python.exe")
    assert isinstance(missing, Unavailable)
    assert f"under {tmp_path / 'elsewhere' / 'Lib' / 'site-packages'}" in missing.reason


def test_git_state_outside_a_repository_is_unavailable_and_names_the_failure(tmp_path: Path) -> None:
    state = git_state(REPO_ROOT)
    assert isinstance(state, GitState) and len(state.commit) == 40 and isinstance(state.dirty, bool)
    missing = git_state(tmp_path)
    assert isinstance(missing, Unavailable)
    assert re.fullmatch(r"git exited with code \d+: .+", missing.reason) is not None


def test_run_reports_unavailable_when_the_command_cannot_be_started() -> None:
    result = environment.run_probe(["definitely-not-a-real-command", "--version"])
    assert isinstance(result, Unavailable)
    assert "definitely-not-a-real-command could not be started" in result.reason


def test_mock_run_environment_does_not_list_inapplicable_fields_as_unavailable() -> None:
    environment = collect_environment(
        None, REPO_ROOT, datetime(2026, 11, 26, 12, tzinfo=UTC), scrubbed_env=[], mocked=True
    )
    assert environment.tabbyapi is None and environment.exllamav3_version is None
    assert "tabbyapi" not in environment.unavailable
    assert "exllamav3_version" not in environment.unavailable


def test_environment_round_trips_and_rejects_unknown_keys() -> None:
    identity = Identity.model_validate(
        {
            "requested": {"presetId": "preset-a", "settings": {"KvCacheQuantization": "q8_0"}},
            "resident": {
                "matches": True,
                "card": {
                    "id": "served-model",
                    "max_seq_len": 32000,
                    "cache_size": 32000,
                    "chunk_size": 2048,
                    "cache_mode": "8,8",
                },
            },
            "drafting": {"configured": False, "verified": None},
            "engine": {
                "managed": True,
                "pythonPath": "C:\\engine\\venv\\Scripts\\python.exe",
                "workingDirectory": "C:\\engine\\tabby",
                "entrypoint": "main.py",
                "environment": {},
            },
            "residency": {"keyHash": "0123456789abcdef", "generation": 9},
        }
    )
    environment = Environment(
        started_at_utc="2026-11-26T12:00:00Z",
        os="Windows-11-10.0.26100",
        cpu="Intel64 Family 6 Model 183",
        python="3.14.0",
        gpu=Gpu(name="NVIDIA GeForce RTX 4090", driver="560.94", memory_total_mib=24564),
        packages={"inspect-ai": "0.3.292", "inspect-evals": None},
        siftkit=GitState(commit="a" * 40, dirty=True),
        tabbyapi=None,
        exllamav3_version="1.6.5",
        unavailable={"gpu": "nvidia-smi could not be started: x"},
        identity=identity,
        scrubbed_env=["OPENAI_API_KEY"],
        mocked=False,
    )
    assert Environment.model_validate(environment.model_dump(mode="json")) == environment
    with pytest.raises(ValidationError):
        Environment.model_validate({**environment.model_dump(mode="json"), "surprise": 1})
