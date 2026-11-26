"""Runs one suite against one variant and writes normalized samples as each task finishes."""

import os
import shutil
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from local_evals.config import ResolvedManifest, TaskCatalog
from local_evals.environment import collect_environment
from local_evals.evaluators.base import (
    Evaluator,
    EvaluatorError,
    LiveModel,
    MockModel,
    TaskRunRequest,
)
from local_evals.guard import scrub_cloud_keys
from local_evals.records import EvaluatedSample, SampleRecord, TaskIssue, TaskIssueCategory
from local_evals.runstore import RunStore
from local_evals.siftkit import BenchClient, Identity


class RunError(Exception):
    """The run cannot start or cannot be trusted; nothing after this point would be labelled correctly."""


@dataclass(frozen=True)
class LiveTarget:
    client: BenchClient
    api_key: str | None


@dataclass(frozen=True)
class MockTarget:
    evaluator_args: Mapping[str, object]


Target = LiveTarget | MockTarget


def prepare_target(target: Target, manifest: ResolvedManifest) -> Identity | None:
    """Loads the preset with a one-token request, then requires the server to vouch for it."""
    if isinstance(target, MockTarget):
        return None
    warm = target.client.chat(
        {
            "model": manifest.model,
            "messages": [{"role": "user", "content": "ready"}],
            "max_tokens": 1,
            "chat_template_kwargs": {"enable_thinking": False},
        }
    )
    if warm.status_code != 200:
        raise RunError(
            f"Warm-up request for {manifest.model!r} answered HTTP {warm.status_code}: {warm.body}"
        )
    identity = target.client.identity(manifest.model)
    if not identity.resident.matches:
        raise RunError(
            f"The resident model does not match preset {manifest.model!r}; refusing to label a run with it."
        )
    return identity


def read_generation(target: Target, model: str) -> int | None:
    return target.client.identity(model).residency.generation if isinstance(target, LiveTarget) else None


def to_record(
    sample: EvaluatedSample,
    *,
    run_id: str,
    experiment_id: str | None,
    variant_id: str,
    evaluator: str,
    raw_log: Path,
    seed: int | None,
    identity: Identity | None,
    generation_start: int | None,
    generation_end: int | None,
) -> SampleRecord:
    return SampleRecord(
        **sample.model_dump(),
        run_id=run_id,
        experiment_id=experiment_id,
        variant_id=variant_id,
        evaluator=evaluator,
        seed=seed,
        raw_log=str(raw_log),
        residency_hash=identity.residency.keyHash if identity is not None else None,
        generation_start=generation_start,
        generation_end=generation_end,
    )


def _note(store: RunStore, task: str, category: TaskIssueCategory, detail: str) -> None:
    issue = TaskIssue(task=task, category=category, detail=detail)
    store.append_jsonl("errors.jsonl", issue.model_dump(mode="json"))


def run_suite(
    manifest: ResolvedManifest,
    catalog: TaskCatalog,
    evaluators: Mapping[str, Evaluator],
    target: Target,
    runs_root: Path,
    repo_root: Path,
    now: datetime,
) -> RunStore:
    removed = scrub_cloud_keys(os.environ)
    model_ref = (
        MockModel(target.evaluator_args)
        if isinstance(target, MockTarget)
        else LiveModel(manifest.model, manifest.endpoint, target.api_key)
    )
    for suite_task in manifest.suite.tasks:
        catalog.get(suite_task.task)
    identity = prepare_target(target, manifest)
    store = RunStore.create(runs_root, manifest, now)
    environment = collect_environment(
        identity, repo_root, now, scrubbed_env=removed, mocked=isinstance(target, MockTarget)
    )
    store.write_json("environment.json", environment.model_dump(mode="json"))
    deadline = time.monotonic() + manifest.limits.max_wall_minutes * 60
    capped = False
    for suite_task in manifest.suite.tasks:
        spec = catalog.get(suite_task.task)
        if time.monotonic() > deadline:
            capped = True
            _note(
                store,
                suite_task.task,
                "skipped",
                f"Wall-clock cap of {manifest.limits.max_wall_minutes} minutes reached.",
            )
            continue
        if spec.sandbox and shutil.which("docker") is None:
            _note(
                store,
                suite_task.task,
                "unavailable",
                "The task needs a Docker sandbox and Docker is not installed.",
            )
            continue
        evaluator = evaluators[spec.evaluator]
        generation_start = read_generation(target, manifest.model)
        try:
            log = evaluator.run(
                TaskRunRequest(
                    task=suite_task.task,
                    task_args=suite_task.task_args,
                    model=model_ref,
                    sample_ids=None,
                    limit=suite_task.limit,
                    generation=manifest.generation,
                    max_tokens=suite_task.max_tokens,
                    max_retries=manifest.limits.max_retries,
                    timeout_seconds=manifest.limits.request_timeout_seconds,
                    log_dir=store.raw_dir(manifest.model, evaluator.name, suite_task.task),
                )
            )
            samples = list(evaluator.read_samples(log))
        except (EvaluatorError, ValueError, OSError) as error:
            _note(store, suite_task.task, "infra_error", f"{type(error).__name__}: {error}")
            continue
        generation_end = read_generation(target, manifest.model)
        for sample in samples:
            record = to_record(
                sample,
                run_id=store.run_id,
                experiment_id=None,
                variant_id=manifest.model,
                evaluator=evaluator.name,
                raw_log=log.path,
                seed=manifest.generation.seed,
                identity=identity,
                generation_start=generation_start,
                generation_end=generation_end,
            )
            store.append_jsonl("samples.jsonl", record.model_dump(mode="json"))
    store.finish("aborted_wall_cap" if capped else "completed", datetime.now(UTC))
    return store
