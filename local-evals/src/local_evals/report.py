"""Per-run summary. Accuracy is reported over completed samples and, conservatively, over all planned ones."""

import csv
import io
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import get_args

from local_evals.environment import Environment
from local_evals.records import MODEL_OUTCOMES, SampleRecord, SampleStatus, TaskIssue
from local_evals.siftkit import Identity

STATUS_ORDER: tuple[SampleStatus, ...] = get_args(SampleStatus)


@dataclass(frozen=True)
class TaskSummary:
    task: str
    planned: int
    # Samples with a model outcome: correct, incorrect, invalid_format or truncated.
    completed: int
    correct: int
    accuracy_completed: float | None
    accuracy_planned: float | None
    counts: Mapping[SampleStatus, int]
    reloaded: bool


def summarize(records: Sequence[SampleRecord], planned: Mapping[str, int]) -> list[TaskSummary]:
    summaries: list[TaskSummary] = []
    for task in sorted({*planned, *(record.task for record in records)}):
        rows = [record for record in records if record.task == task]
        counts = Counter(record.status for record in rows)
        completed = sum(counts[status] for status in MODEL_OUTCOMES)
        correct = counts["correct"]
        total = planned.get(task, len(rows))
        summaries.append(
            TaskSummary(
                task=task,
                planned=total,
                completed=completed,
                correct=correct,
                accuracy_completed=correct / completed if completed else None,
                accuracy_planned=correct / total if total else None,
                counts={status: counts[status] for status in STATUS_ORDER},
                reloaded=any(record.generation_start != record.generation_end for record in rows),
            )
        )
    return summaries


def percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def identity_lines(identity: Identity | None) -> list[str]:
    """What the server vouched for. An unverified value is printed as unverified, never as measured."""
    if identity is None:
        return ["- Identity: not verified"]
    card = identity.resident.card
    configured_kv = identity.requested.settings.get("KvCacheQuantization")
    context = f"- Context: {card.max_seq_len} (verified)" if card is not None else "- Context: unverified"
    if card is not None and card.cache_mode is not None:
        kv = f"- KV cache: {card.cache_mode} (verified)"
    else:
        kv = f"- KV cache: unverified (configured {configured_kv})"
    drafting_state = "verified" if identity.drafting.verified is True else "unverified"
    return [context, kv, f"- Drafting: configured {identity.drafting.configured}, {drafting_state}"]


def render_markdown(
    summaries: Sequence[TaskSummary],
    environment: Environment,
    *,
    run_id: str,
    model: str,
    generation: str,
    digest: str,
    issues: Sequence[TaskIssue],
) -> str:
    lines = [f"# Run {run_id}", ""]
    if environment.mocked:
        lines += ["**MOCKED RUN: no model was called. These numbers say nothing about any model.**", ""]
    lines += [
        f"- Model preset: {model}",
        f"- Generation profile: {generation}",
        f"- Manifest digest: {digest}",
        *identity_lines(environment.identity),
    ]
    reloaded = [summary.task for summary in summaries if summary.reloaded]
    if reloaded:
        lines.append(f"- Model reloaded during: {', '.join(reloaded)}")
    lines += [
        "",
        "| Task | Planned | Completed | Correct | Accuracy (completed) | "
        "Accuracy (planned) | Invalid format | Truncated | Input too long | "
        "Timeout | Infra error |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for summary in summaries:
        counts = summary.counts
        lines.append(
            f"| {summary.task} | {summary.planned} | {summary.completed} | {summary.correct} | "
            f"{percent(summary.accuracy_completed)} | {percent(summary.accuracy_planned)} | "
            f"{counts['invalid_format']} | {counts['truncated']} | {counts['input_too_long']} | "
            f"{counts['timeout']} | {counts['infra_error']} |"
        )
    if issues:
        lines += ["", "## Tasks that did not produce samples", ""]
        lines += [f"- {issue.task}: {issue.category} - {issue.detail}" for issue in issues]
    lines += [
        "",
        "Accuracy (completed) excludes operational failures. Accuracy (planned) counts every planned "
        "sample that is not correct as a miss.",
    ]
    return "\n".join(lines) + "\n"


def render_csv(summaries: Sequence[TaskSummary]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        [
            "task",
            "planned",
            "completed",
            "correct",
            "accuracy_completed",
            "accuracy_planned",
            *STATUS_ORDER,
            "reloaded",
        ]
    )
    for summary in summaries:
        writer.writerow(
            [
                summary.task,
                summary.planned,
                summary.completed,
                summary.correct,
                "" if summary.accuracy_completed is None else summary.accuracy_completed,
                "" if summary.accuracy_planned is None else summary.accuracy_planned,
                *(summary.counts[status] for status in STATUS_ORDER),
                summary.reloaded,
            ]
        )
    return buffer.getvalue()
