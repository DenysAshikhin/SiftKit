"""Captures what a run ran on. Reads files and asks git and nvidia-smi; never runs the engine."""

import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from importlib import metadata
from pathlib import Path

from local_evals.config import Strict
from local_evals.runstore import utc_text
from local_evals.siftkit import Identity

PACKAGES = ("inspect-ai", "inspect-evals", "openai", "httpx", "pydantic")
# How long a probe command may run before its field is reported unavailable.
PROBE_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class Unavailable:
    reason: str


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
    unavailable: dict[str, str]
    identity: Identity | None
    scrubbed_env: list[str]
    mocked: bool


def run_probe(command: list[str]) -> str | Unavailable:
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS, check=False
        )
    except OSError as error:
        return Unavailable(f"{command[0]} could not be started: {error}")
    except subprocess.TimeoutExpired:
        return Unavailable(f"{command[0]} timed out after {PROBE_TIMEOUT_SECONDS} seconds")
    if completed.returncode != 0:
        stderr = next(
            (line.strip() for line in completed.stderr.splitlines() if line.strip()), "no error output"
        )
        return Unavailable(f"{command[0]} exited with code {completed.returncode}: {stderr}")
    return completed.stdout.strip()


def git_state(directory: Path) -> GitState | Unavailable:
    commit = run_probe(["git", "-C", str(directory), "rev-parse", "HEAD"])
    if isinstance(commit, Unavailable):
        return commit
    status = run_probe(["git", "-C", str(directory), "status", "--porcelain"])
    if isinstance(status, Unavailable):
        return status
    return GitState(commit=commit, dirty=status != "")


def exllamav3_version(python_path: Path) -> str | Unavailable:
    """Version of the engine installed next to `python_path`, read from its dist-info directory name."""
    site_packages = python_path.parent.parent / "Lib" / "site-packages"
    matches = sorted(site_packages.glob("exllamav3-*.dist-info"))
    if not matches:
        return Unavailable(f"no exllamav3 dist-info directory under {site_packages}")
    return matches[-1].name.removeprefix("exllamav3-").removesuffix(".dist-info")


def _gpu() -> Gpu | Unavailable:
    row = run_probe(
        ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]
    )
    if isinstance(row, Unavailable):
        return row
    fields = [field.strip() for field in row.splitlines()[0].split(",")] if row else []
    if len(fields) != 3 or not fields[2].isdigit():
        return Unavailable(f"nvidia-smi printed an unexpected row: {row!r}")
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
    gpu = _gpu()
    siftkit = git_state(repo_root)
    tabbyapi = git_state(Path(identity.engine.workingDirectory)) if identity is not None else None
    engine_version = exllamav3_version(Path(identity.engine.pythonPath)) if identity is not None else None
    unavailable: dict[str, str] = {}
    if isinstance(gpu, Unavailable):
        unavailable["gpu"] = gpu.reason
    if isinstance(siftkit, Unavailable):
        unavailable["siftkit"] = siftkit.reason
    if isinstance(tabbyapi, Unavailable):
        unavailable["tabbyapi"] = tabbyapi.reason
    if isinstance(engine_version, Unavailable):
        unavailable["exllamav3_version"] = engine_version.reason
    return Environment(
        started_at_utc=utc_text(started_at),
        os=platform.platform(),
        cpu=platform.processor() or None,
        python=sys.version.split()[0],
        gpu=None if isinstance(gpu, Unavailable) else gpu,
        packages={name: _package_version(name) for name in PACKAGES},
        siftkit=None if isinstance(siftkit, Unavailable) else siftkit,
        tabbyapi=None if isinstance(tabbyapi, Unavailable) else tabbyapi,
        exllamav3_version=None if isinstance(engine_version, Unavailable) else engine_version,
        unavailable=unavailable,
        identity=identity,
        scrubbed_env=scrubbed_env,
        mocked=mocked,
    )
