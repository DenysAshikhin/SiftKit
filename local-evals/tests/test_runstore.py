from datetime import UTC, datetime
from pathlib import Path

import pytest

from local_evals.config import resolve_manifest
from local_evals.paths import PROJECT_ROOT
from local_evals.runstore import RunStore, RunStoreError

NOW = datetime(2026, 11, 26, 12, 30, 5, tzinfo=UTC)


def make_store(root: Path) -> RunStore:
    manifest = resolve_manifest(
        PROJECT_ROOT / "configs",
        endpoint="siftkit-local",
        model="preset-a",
        suite="smoke",
        generation="fixed-v1",
    )
    return RunStore.create(root, manifest, NOW)


def test_create_writes_manifest_and_running_state(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.run_id.startswith("20261126T123005Z-")
    assert (store.directory / "manifest.resolved.json").is_file()
    assert store.read_json("manifest.resolved.json")["model"] == "preset-a"
    state = store.read_json("state.json")
    assert state["status"] == "running"
    assert isinstance(state["manifest_digest"], str) and len(state["manifest_digest"]) == 64

    store.finish("completed", NOW)
    assert store.read_json("state.json")["status"] == "completed"
    assert RunStore.open(tmp_path, store.run_id).directory == store.directory


def test_jsonl_appends_survive_a_torn_last_line(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.append_jsonl("samples.jsonl", {"sample_id": "a"})
    store.append_jsonl("samples.jsonl", {"sample_id": "b"})
    with (store.directory / "samples.jsonl").open("a", encoding="utf-8") as handle:
        handle.write('{"sample_id": "c", "sco')
    assert [row["sample_id"] for row in store.read_jsonl("samples.jsonl")] == ["a", "b"]
    assert store.read_jsonl("never-written.jsonl") == []


def test_read_json_rejects_a_non_object_and_broken_json(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.write_text("list.json", "[]")
    with pytest.raises(RunStoreError):
        store.read_json("list.json")
    store.write_text("broken.json", "{broken")
    with pytest.raises(RunStoreError):
        store.read_json("broken.json")


def test_read_jsonl_rejects_a_complete_non_object_line(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.write_text("samples.jsonl", '{"sample_id": "a"}\nnot json\n{"sample_id": "b"}\n')
    with pytest.raises(RunStoreError, match="line 2"):
        store.read_jsonl("samples.jsonl")


def test_atomic_write_leaves_no_temp_file_and_raw_dirs_are_per_task(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.write_json("summary.json", {"ok": True})
    assert [path.name for path in store.directory.iterdir() if path.suffix == ".tmp"] == []
    raw = store.raw_dir("preset-a", "inspect", "inspect_evals/gsm8k")
    assert raw == store.directory / "raw" / "preset-a" / "inspect" / "inspect_evals__gsm8k"


def test_opening_a_missing_run_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(RunStoreError, match="no-such-run"):
        RunStore.open(tmp_path, "no-such-run")
