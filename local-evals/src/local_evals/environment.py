"""Captures what a run ran on. Reads files and asks git and nvidia-smi; never runs the engine."""

import platform
import subprocess
import sys
from datetime import datetime
from importlib import metadata
from pathlib import Path

from local_evals.config import Strict
from local_evals.runstore import utc_text
from local_evals.siftkit import Identity

PACKAGES = ("inspect-ai", "inspect-evals", "openai", "httpx", "pydantic")


class GitState(Strict):
    commit: str
    dirty: bool


class Gpu(Strict):
    name: str
    driver: str
    memory_total_mib: int


class Environment(Strict):
    started_at_utc: str
    os: str
    cpu: str | None
    python: str
    gpu: Gpu | None
    packages: dict[str, str | None]
    siftkit: GitState | None
    tabbyapi: GitState | None
    exllamav3_version: str | None
    identity: Identity | None
    scrubbed_env: list[str]
    mocked: bool


def _run(command: list[str]) -> str | None:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


def git_state(directory: Path) -> GitState | None:
    commit = _run(["git", "-C", str(directory), "rev-parse", "HEAD"])
    status = _run(["git", "-C", str(directory), "status", "--porcelain"])
    if commit is None or status is None:
        return None
    return GitState(commit=commit, dirty=status != "")


def exllamav3_version(python_path: Path) -> str | None:
    """Version of the engine installed next to `python_path`, read from its dist-info directory name."""
    site_packages = python_path.parent.parent / "Lib" / "site-packages"
    matches = sorted(site_packages.glob("exllamav3-*.dist-info"))
    return matches[-1].name.removeprefix("exllamav3-").removesuffix(".dist-info") if matches else None


def _gpu() -> Gpu | None:
    row = _run(
        ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]
    )
    if not row:
        return None
    fields = [field.strip() for field in row.splitlines()[0].split(",")]
    if len(fields) != 3 or not fields[2].isdigit():
        return None
    return Gpu(name=fields[0], driver=fields[1], memory_total_mib=int(fields[2]))


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def collect_environment(
    identity: Identity | None,
    repo_root: Path,
    started_at: datetime,
    *,
    scrubbed_env: list[str],
    mocked: bool,
) -> Environment:
    return Environment(
        started_at_utc=utc_text(started_at),
        os=platform.platform(),
        cpu=platform.processor() or None,
        python=sys.version.split()[0],
        gpu=_gpu(),
        packages={name: _package_version(name) for name in PACKAGES},
        siftkit=git_state(repo_root),
        tabbyapi=git_state(Path(identity.engine.workingDirectory)) if identity is not None else None,
        exllamav3_version=exllamav3_version(Path(identity.engine.pythonPath))
        if identity is not None
        else None,
        identity=identity,
        scrubbed_env=scrubbed_env,
        mocked=mocked,
    )
