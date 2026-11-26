"""One run's directory. Whole files are replaced atomically; JSONL files only ever grow."""

import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import JsonValue, ValidationError

from local_evals.config import ResolvedManifest
from local_evals.jsonio import JSON_OBJECT

RunStatus = Literal["running", "completed", "failed", "aborted_wall_cap"]


class RunStoreError(Exception):
    """A run directory is missing or unreadable."""


def utc_text(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class RunStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @property
    def run_id(self) -> str:
        return self.directory.name

    @classmethod
    def create(cls, runs_root: Path, manifest: ResolvedManifest, now: datetime) -> "RunStore":
        run_id = f"{now.astimezone(UTC):%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"
        directory = runs_root / run_id
        directory.mkdir(parents=True, exist_ok=False)
        store = cls(directory)
        store.write_json("manifest.resolved.json", manifest.model_dump(mode="json"))
        store.write_json(
            "state.json",
            {
                "status": "running",
                "manifest_digest": manifest.digest(),
                "started_at_utc": utc_text(now),
                "finished_at_utc": None,
            },
        )
        return store

    @classmethod
    def open(cls, runs_root: Path, run_id: str) -> "RunStore":
        directory = runs_root / run_id
        if not (directory / "state.json").is_file():
            raise RunStoreError(f"Run {run_id!r} does not exist under {runs_root}.")
        return cls(directory)

    def write_text(self, name: str, text: str) -> None:
        target = self.directory / name
        temporary = target.with_name(f"{target.name}.tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, target)

    def write_json(self, name: str, payload: dict[str, JsonValue]) -> None:
        self.write_text(name, json.dumps(payload, indent=2, sort_keys=True))

    def read_json(self, name: str) -> dict[str, JsonValue]:
        try:
            return JSON_OBJECT.validate_json((self.directory / name).read_text(encoding="utf-8"))
        except ValidationError as error:
            raise RunStoreError(f"{self.directory / name} does not hold a JSON object.") from error

    def append_jsonl(self, name: str, record: dict[str, JsonValue]) -> None:
        with (self.directory / name).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def read_jsonl(self, name: str) -> list[dict[str, JsonValue]]:
        """Reads complete lines only; a torn final line from an interrupted write is dropped."""
        path = self.directory / name
        if not path.is_file():
            return []
        text = path.read_text(encoding="utf-8")
        lines = text.split("\n")
        complete = lines if text.endswith("\n") else lines[:-1]
        rows: list[dict[str, JsonValue]] = []
        for number, line in enumerate(complete, start=1):
            if not line:
                continue
            try:
                rows.append(JSON_OBJECT.validate_json(line))
            except ValidationError as error:
                raise RunStoreError(f"{path} line {number} is not a JSON object.") from error
        return rows

    def raw_dir(self, variant: str, evaluator: str, task: str) -> Path:
        return self.directory / "raw" / variant / evaluator / task.replace("/", "__")

    def finish(self, status: RunStatus, now: datetime) -> None:
        state = self.read_json("state.json")
        self.write_json("state.json", {**state, "status": status, "finished_at_utc": utc_text(now)})
