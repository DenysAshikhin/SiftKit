"""Validated configuration. Every file is parsed into a frozen model; unknown keys are errors."""

import hashlib
import json
from pathlib import Path
from typing import Literal, TypeVar

import yaml
from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError, field_validator

from local_evals.guard import CloudEndpointError, assert_loopback


class ConfigError(Exception):
    """A configuration file is missing, malformed, or names something that does not exist."""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Endpoint(Strict):
    base_url: str
    # Name of the environment variable holding the key; the key itself is never stored.
    api_key_env: str | None

    @field_validator("base_url")
    @classmethod
    def _require_loopback(cls, value: str) -> str:
        try:
            assert_loopback(value)
        except CloudEndpointError as error:
            raise ValueError(str(error)) from error
        return value.rstrip("/")


class ModelProvenance(Strict):
    """Facts SiftKit cannot know. Every key is required; an unknown value is an explicit null."""

    base_checkpoint: str | None
    hf_repo: str | None
    hf_revision: str | None
    quant_format: str | None
    nominal_bpw: float | None
    quantizer_revision: str | None
    calibration: str | None
    tokenizer: str | None


class Registry(Strict):
    endpoints: dict[str, Endpoint]
    models: dict[str, ModelProvenance]

    def endpoint(self, name: str, source: Path) -> Endpoint:
        """The named endpoint; the error names the file it should be defined in."""
        if name not in self.endpoints:
            raise ConfigError(f"Endpoint {name!r} is not defined in {source}.")
        return self.endpoints[name]


class GenerationProfile(Strict):
    name: str
    temperature: float
    top_p: float
    top_k: int | None
    min_p: float | None
    seed: int | None
    enable_thinking: bool
    reasoning_effort: str | None


class TaskSpec(Strict):
    id: str
    evaluator: Literal["inspect"]
    sandbox: bool
    judge: bool
    extras: list[str]
    dataset: str | None
    license: str | None
    # The evaluator release this entry was checked against.
    verified_with: str


class TaskCatalog(Strict):
    tasks: list[TaskSpec]

    def get(self, task_id: str) -> TaskSpec:
        for spec in self.tasks:
            if spec.id == task_id:
                return spec
        raise ConfigError(f"Task {task_id!r} is not in configs/tasks.yaml; only catalogued tasks can run.")


class SuiteTask(Strict):
    task: str
    limit: int | None
    max_tokens: int
    task_args: dict[str, JsonValue] = {}


class Suite(Strict):
    name: str
    tasks: list[SuiteTask]


class Limits(Strict):
    max_wall_minutes: int
    max_retries: int
    request_timeout_seconds: int
    allow_cloud: Literal[False]


class ResolvedManifest(Strict):
    kind: Literal["suite"]
    endpoint_name: str
    endpoint: Endpoint
    model: str
    provenance: ModelProvenance | None
    generation: GenerationProfile
    suite: Suite
    limits: Limits

    def digest(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


ModelT = TypeVar("ModelT", bound=BaseModel)


def load_yaml(path: Path, model: type[ModelT]) -> ModelT:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(f"Config file not found: {path}") from error
    except yaml.YAMLError as error:
        raise ConfigError(f"{path}: invalid YAML: {error}") from error
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error


def load_endpoint(config_dir: Path, name: str) -> Endpoint:
    """The named endpoint from models.yaml."""
    source = config_dir / "models.yaml"
    return load_yaml(source, Registry).endpoint(name, source)


def resolve_manifest(
    config_dir: Path,
    *,
    endpoint: str,
    model: str,
    suite: str,
    generation: str,
) -> ResolvedManifest:
    registry = load_yaml(config_dir / "models.yaml", Registry)
    return ResolvedManifest(
        kind="suite",
        endpoint_name=endpoint,
        endpoint=registry.endpoint(endpoint, config_dir / "models.yaml"),
        model=model,
        provenance=registry.models.get(model),
        generation=load_yaml(config_dir / "generation" / f"{generation}.yaml", GenerationProfile),
        suite=load_yaml(config_dir / "suites" / f"{suite}.yaml", Suite),
        limits=load_yaml(config_dir / "limits.yaml", Limits),
    )
