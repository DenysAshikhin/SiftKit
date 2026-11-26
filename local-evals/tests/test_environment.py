from pathlib import Path

import pytest
from pydantic import ValidationError

from local_evals.environment import Environment, GitState, Gpu, exllamav3_version, git_state
from local_evals.paths import REPO_ROOT
from local_evals.siftkit import Identity


def test_exllamav3_version_is_read_from_site_packages_without_running_the_interpreter(tmp_path: Path) -> None:
    python = tmp_path / "venv" / "Scripts" / "python.exe"
    (tmp_path / "venv" / "Lib" / "site-packages" / "exllamav3-1.6.5.dist-info").mkdir(parents=True)
    assert exllamav3_version(python) == "1.6.5"
    assert exllamav3_version(tmp_path / "elsewhere" / "Scripts" / "python.exe") is None


def test_git_state_reports_commit_and_dirty_flag_or_none_outside_a_repository(tmp_path: Path) -> None:
    state = git_state(REPO_ROOT)
    assert state is not None and len(state.commit) == 40 and isinstance(state.dirty, bool)
    assert git_state(tmp_path) is None


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
        identity=identity,
        scrubbed_env=["OPENAI_API_KEY"],
        mocked=False,
    )
    assert Environment.model_validate(environment.model_dump(mode="json")) == environment
    with pytest.raises(ValidationError):
        Environment.model_validate({**environment.model_dump(mode="json"), "surprise": 1})
