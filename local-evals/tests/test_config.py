from pathlib import Path

import pytest
from pydantic import ValidationError

from local_evals.config import (
    ConfigError,
    Endpoint,
    GenerationProfile,
    Limits,
    Registry,
    Suite,
    TaskCatalog,
    load_yaml,
    resolve_manifest,
)
from local_evals.paths import PROJECT_ROOT

CONFIGS = PROJECT_ROOT / "configs"


def test_endpoint_refuses_a_non_loopback_base_url() -> None:
    # The only guard on where a live model points: a LiveModel can only hold an Endpoint.
    for base_url in ("https://api.openai.com/v1", "http://192.168.1.20:4765/bench/v1"):
        with pytest.raises(ValidationError, match="loopback"):
            Endpoint(base_url=base_url, api_key_env=None)


def test_shipped_configs_load_and_resolve() -> None:
    manifest = resolve_manifest(
        CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw", suite="smoke", generation="fixed-v1"
    )
    assert manifest.endpoint.base_url == "http://127.0.0.1:4765/bench/v1"
    assert [task.task for task in manifest.suite.tasks] == [
        "inspect_evals/gsm8k",
        "local_evals/structured_output",
    ]
    assert manifest.generation.seed == 42
    assert manifest.limits.allow_cloud is False
    assert manifest.provenance is not None and manifest.provenance.nominal_bpw == 5.0
    assert len(manifest.digest()) == 64
    again = resolve_manifest(
        CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw", suite="smoke", generation="fixed-v1"
    )
    assert manifest.digest() == again.digest()
    greedy = resolve_manifest(
        CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw", suite="smoke", generation="greedy-v1"
    )
    assert greedy.digest() != manifest.digest()


def test_a_model_without_provenance_resolves_with_none() -> None:
    manifest = resolve_manifest(
        CONFIGS, endpoint="siftkit-local", model="unlisted-preset", suite="smoke", generation="fixed-v1"
    )
    assert manifest.provenance is None


def test_invalid_configs_fail_with_the_file_named(tmp_path: Path) -> None:
    unknown_key = tmp_path / "suite.yaml"
    unknown_key.write_text("name: s\ntasks: []\nsurprise: 1\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="suite.yaml"):
        load_yaml(unknown_key, Suite)

    cloud = tmp_path / "models.yaml"
    cloud.write_text(
        "endpoints:\n  x:\n    base_url: https://api.openai.com/v1\n    api_key_env: null\nmodels: {}\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError, match="loopback"):
        load_yaml(cloud, Registry)

    allow_cloud = tmp_path / "limits.yaml"
    allow_cloud.write_text(
        "max_wall_minutes: 1\nmax_retries: 1\nrequest_timeout_seconds: 1\nallow_cloud: true\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError):
        load_yaml(allow_cloud, Limits)

    with pytest.raises(ConfigError, match="not found"):
        load_yaml(tmp_path / "missing.yaml", GenerationProfile)


def test_unknown_names_are_config_errors() -> None:
    with pytest.raises(ConfigError, match="no-such-endpoint"):
        resolve_manifest(
            CONFIGS, endpoint="no-such-endpoint", model="m", suite="smoke", generation="fixed-v1"
        )
    catalog = load_yaml(CONFIGS / "tasks.yaml", TaskCatalog)
    with pytest.raises(ConfigError, match="not-in-catalog"):
        catalog.get("not-in-catalog")
