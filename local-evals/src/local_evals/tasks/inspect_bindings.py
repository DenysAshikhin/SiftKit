"""Inspect wrappers over the plain task functions in this package. No scoring logic lives here."""

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import Score, Scorer, Target, accuracy, scorer, stderr
from inspect_ai.solver import TaskState, generate

from local_evals.paths import FIXTURES
from local_evals.tasks.structured import StructuredCase, load_cases, render_prompt, score_structured


@scorer(metrics=[accuracy(), stderr()])
def structured_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        case = StructuredCase.model_validate(state.metadata["case"])
        result = score_structured(state.output.completion, case)
        return Score(
            value=result.value,
            answer=state.output.completion,
            explanation=result.explanation,
            metadata={"status": result.status},
        )

    return score


@task
def structured_output(fixture: str = "structured/v1.jsonl") -> Task:
    samples = [
        Sample(
            id=case.id,
            input=render_prompt(case),
            target=str(case.expected),
            metadata={"case": case.model_dump()},
        )
        for case in load_cases(FIXTURES / fixture)
    ]
    return Task(dataset=MemoryDataset(samples), solver=generate(), scorer=structured_scorer(), version=1)
