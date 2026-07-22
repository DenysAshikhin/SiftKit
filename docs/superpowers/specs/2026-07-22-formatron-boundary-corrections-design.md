# Formatron Boundary Corrections Design

## Goal

Keep SiftKit's planner schema canonical while adapting it only for Formatron, reject repaired planner corruption, and exercise the real Formatron/kbnf boundary automatically when its runtime is available.

## Architecture

`structured-output-schema.ts` builds one standards-compliant schema: optional properties remain optional and `tool_batch.calls` retains `minItems: 1`. `InferenceRequestBuilder` is the provider boundary because it already knows the active backend. For EXL3 requests only, a focused lowering pass converts optional object properties to required-nullable properties and removes `minItems` only from the discriminated `tool_batch.calls` array. Llama requests receive the canonical schema unchanged.

Planner parsing retains whether JSON was strict or repaired. It compares semantic null values after repair with unquoted `null` tokens in the original text; a repaired planner payload that gained null values is rejected as synthesized corruption. Explicit null is removed only when the selected tool's supplied JSON Schema declares that top-level property optional. Required-nullable and undeclared null values remain visible. Summary and repo-search parsers receive their active tool definitions, so schema generation and omission use the same declarations.

Batch validation is one shared parser operation that requires a non-empty array of object calls. Summary and repo-search validation reuse it.

## Integration Harness

A Node integration test is gated by `SIFTKIT_FORMATRON_PYTHON`, `SIFTKIT_TABBY_ROOT`, and `SIFTKIT_EXL3_MODEL_DIR`. When configured, it builds the EXL3-lowered real repo-search planner schema, sends it to a Python harness through stdin, loads the real model tokenizer, compiles through TabbyAPI's `ExLlamaV3Grammar`/Formatron/kbnf path, and verifies the payload corpus from handoff §9.6. It asserts a bounded cold compile time, accepts direct/all-null/all-populated and one-/two-call batches, and rejects dangling values and bogus batch items. Without the environment, the test reports a skip rather than pretending to cover the boundary.

## Testing

TDD cycles cover:

- repaired missing values rejected while safe repairs remain accepted;
- explicit null retained for required or undeclared fields and omitted only for schema-optional fields;
- canonical schema constraints preserved;
- EXL3 request lowering and llama pass-through;
- centralized empty-batch rejection;
- gated real Formatron compile and acceptance corpus.

Focused tests run after each change, followed by typecheck, full tests, coverage, and build.
