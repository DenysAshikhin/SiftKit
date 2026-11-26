"""Command line. Parses arguments, wires the modules together, and maps errors to exit codes."""

import argparse
import dataclasses
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue

from local_evals.config import (
    ConfigError,
    ResolvedManifest,
    TaskCatalog,
    load_endpoint,
    load_yaml,
    resolve_manifest,
)
from local_evals.doctor import Check, check_overflow, has_failure, run_doctor
from local_evals.environment import Environment
from local_evals.evaluators.base import EvaluatorError
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.guard import CloudEndpointError
from local_evals.paths import REPO_ROOT
from local_evals.records import SampleRecord, TaskIssue
from local_evals.report import render_csv, render_markdown, summarize
from local_evals.runner import LiveTarget, MockTarget, RunError, Target, run_suite
from local_evals.runstore import RunStore, RunStoreError
from local_evals.siftkit import BenchClient, BenchError

EXIT_OK, EXIT_CHECK_FAILED, EXIT_ERROR = 0, 1, 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="local-evals", description="Local model evaluation harness.")
    parser.add_argument("--config-dir", type=Path, default=Path("configs"))
    parser.add_argument("--runs-dir", type=Path, default=Path("runs"))
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    commands = parser.add_subparsers(dest="command", required=True)

    doctor = commands.add_parser("doctor", help="Preflight an endpoint and a model preset.")
    doctor.add_argument("--endpoint", default="siftkit-local")
    doctor.add_argument("--model", required=True)
    doctor.add_argument(
        "--check-overflow", action="store_true", help="Also send a prompt larger than the context."
    )

    list_models = commands.add_parser("list-models", help="List the model presets the endpoint serves.")
    list_models.add_argument("--endpoint", default="siftkit-local")

    commands.add_parser("list-tasks", help="List the catalogued tasks.")

    run = commands.add_parser("run", help="Run a suite against one model preset.")
    run.add_argument("--suite", required=True)
    run.add_argument("--model", required=True)
    run.add_argument("--endpoint", default="siftkit-local")
    run.add_argument("--generation", default="fixed-v1")
    run.add_argument(
        "--dry-run", action="store_true", help="Validate and print planned work; contact nothing."
    )
    run.add_argument("--mock", action="store_true", help="Use the mock model; proves the pipeline only.")
    run.add_argument("--allow-dataset-download", action="store_true")

    report = commands.add_parser("report", help="Print a run's report.")
    report.add_argument("--run-id", required=True)
    report.add_argument("--format", choices=("markdown", "csv"), default="markdown")
    return parser


def open_client(config_dir: Path, endpoint_name: str) -> tuple[BenchClient, str | None]:
    endpoint = load_endpoint(config_dir, endpoint_name)
    api_key = os.environ.get(endpoint.api_key_env) if endpoint.api_key_env else None
    return BenchClient(endpoint, api_key), api_key


def emit(as_json: bool, payload: JsonValue, text: str) -> None:
    print(json.dumps(payload, indent=2) if as_json else text)


def _doctor(args: argparse.Namespace) -> int:
    client, _ = open_client(args.config_dir, args.endpoint)
    checks = run_doctor(client, args.model)
    if args.check_overflow and not has_failure(checks):
        context = client.identity(args.model).requested.settings.get("NumCtx")
        if isinstance(context, int):
            checks.append(check_overflow(client, args.model, context))
        else:
            checks.append(
                Check(
                    "overflow",
                    "skipped",
                    "The preset reports no integer NumCtx; the context size is unknown.",
                )
            )
    text = "\n".join(f"{check.status:<11} {check.name:<18} {check.detail}" for check in checks)
    emit(args.json, [dataclasses.asdict(check) for check in checks], text)
    return EXIT_CHECK_FAILED if has_failure(checks) else EXIT_OK


def _list_models(args: argparse.Namespace) -> int:
    models = open_client(args.config_dir, args.endpoint)[0].list_models()
    emit(args.json, [*models], "\n".join(models))
    return EXIT_OK


def _list_tasks(args: argparse.Namespace) -> int:
    catalog = load_yaml(args.config_dir / "tasks.yaml", TaskCatalog)
    text = "\n".join(
        f"{spec.id:<36} evaluator={spec.evaluator} sandbox={spec.sandbox} judge={spec.judge} "
        f"dataset={spec.dataset} verified_with={spec.verified_with}"
        for spec in catalog.tasks
    )
    emit(args.json, [spec.model_dump(mode="json") for spec in catalog.tasks], text)
    return EXIT_OK


def planned_work(manifest: ResolvedManifest, catalog: TaskCatalog) -> dict[str, JsonValue]:
    tasks: list[JsonValue] = []
    for suite_task in manifest.suite.tasks:
        spec = catalog.get(suite_task.task)
        tasks.append(
            {
                "task": suite_task.task,
                "evaluator": spec.evaluator,
                "limit": suite_task.limit,
                "max_tokens": suite_task.max_tokens,
                "sandbox": spec.sandbox,
                "judge": spec.judge,
                "dataset": spec.dataset,
            }
        )
    return {
        "model": manifest.model,
        "endpoint": manifest.endpoint.base_url,
        "suite": manifest.suite.name,
        "generation": manifest.generation.name,
        "manifest_digest": manifest.digest(),
        "tasks": tasks,
        "provenance": manifest.provenance.model_dump(mode="json") if manifest.provenance else None,
    }


def write_report(store: RunStore, manifest: ResolvedManifest) -> None:
    records = [SampleRecord.model_validate(row) for row in store.read_jsonl("samples.jsonl")]
    planned = {task.task: task.limit for task in manifest.suite.tasks if task.limit is not None}
    summaries = summarize(records, planned)
    store.write_json("summary.json", {"tasks": [dataclasses.asdict(summary) for summary in summaries]})
    store.write_text(
        "report.md",
        render_markdown(
            summaries,
            Environment.model_validate(store.read_json("environment.json")),
            run_id=store.run_id,
            model=manifest.model,
            generation=manifest.generation.name,
            digest=manifest.digest(),
            issues=[TaskIssue.model_validate(row) for row in store.read_jsonl("errors.jsonl")],
        ),
    )
    store.write_text("report.csv", render_csv(summaries))


def _run(args: argparse.Namespace) -> int:
    manifest = resolve_manifest(
        args.config_dir,
        endpoint=args.endpoint,
        model=args.model,
        suite=args.suite,
        generation=args.generation,
    )
    catalog = load_yaml(args.config_dir / "tasks.yaml", TaskCatalog)
    plan = planned_work(manifest, catalog)
    if args.dry_run:
        emit(args.json, plan, json.dumps(plan, indent=2))
        return EXIT_OK
    if not args.allow_dataset_download:
        # Evaluators then fail fast on a dataset that is not already cached instead of fetching it.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_DATASETS_OFFLINE"] = "1"
    target: Target
    if args.mock:
        target = MockTarget({})
    else:
        client, api_key = open_client(args.config_dir, args.endpoint)
        target = LiveTarget(client=client, api_key=api_key)
    store = run_suite(
        manifest,
        catalog,
        {"inspect": InspectEvaluator()},
        target,
        args.runs_dir,
        REPO_ROOT,
        datetime.now(UTC),
    )
    write_report(store, manifest)
    emit(
        args.json,
        {"run_id": store.run_id, "directory": str(store.directory)},
        f"Run {store.run_id} written to {store.directory}",
    )
    return EXIT_OK


def _report(args: argparse.Namespace) -> int:
    store = RunStore.open(args.runs_dir, args.run_id)
    name = "report.csv" if args.format == "csv" else "report.md"
    print((store.directory / name).read_text(encoding="utf-8"), end="")
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            return _doctor(args)
        if args.command == "list-models":
            return _list_models(args)
        if args.command == "list-tasks":
            return _list_tasks(args)
        if args.command == "run":
            return _run(args)
        return _report(args)
    except (ConfigError, CloudEndpointError, BenchError, EvaluatorError, RunError, RunStoreError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
