# Formatron-Compatible Planner Schema Design

## Goal

Make SiftKit planner schemas compile quickly and correctly under TabbyAPI's Formatron/kbnf constrained decoding while preserving SiftKit's runtime tool-call contract.

## Scope

- Normalize planner tool-action schemas so every declared property is required.
- Keep originally required properties non-null.
- Make originally optional properties nullable.
- Apply the transformation recursively to nested object properties and array items.
- Remove `minItems: 1` from `tool_batch.calls`.
- Remove top-level null placeholders before parsed tool arguments reach executors.
- Preserve nested null values because tools such as `json_filter` can use JSON null as data.
- Cover summary and repo-search planner schemas because both use the shared schema builder.
- Validate with automated tests and, when the configured exl3 service is available, the live planner grammar.

## Non-goals

- Fix Formatron's optional-property or `minItems` grammar generation upstream.
- Change the already-implemented TabbyAPI grammar prototype cache.
- Map TabbyAPI `prompt_time` telemetry.
- Add compatibility branches for the old planner wire shape.

## Root Cause

SiftKit currently sends valid JSON Schema, but two Formatron defects miscompile its shape. Optional object fields become unconditional keys with nullable values, creating invalid accepted forms such as `"limit":` and causing kbnf nullable elimination to expand a sequence of k optional values into 2^k variants. Separately, `minItems: 1` emits a leading comma and replaces the declared item schema with unconstrained `json_value`, making valid `tool_batch` arrays unreachable while accepting bogus item shapes.

## Schema Transformation

The shared planner schema builder will normalize each tool parameter schema at the boundary where it constructs direct-action and batch-item variants.

For each object schema:

1. Record its original `required` property names.
2. Recursively normalize every property schema.
3. Leave originally required property schemas non-null.
4. Wrap each originally optional property schema in a nullable union.
5. Set `required` to every declared property name.
6. Preserve descriptions, enums, `additionalProperties`, and other constraints inside the non-null branch.

Nullable optional properties will use `anyOf: [originalSchema, { type: "null" }]`. This works for enums and unconstrained schemas without weakening their non-null branch or requiring special cases for `type`, `enum`, or `{}`.

Array schemas retain their existing constraints and recursively normalize `items`. The sole exception is SiftKit's `tool_batch.calls`, where `minItems` is removed because Formatron miscompiles it. SiftKit's parser remains the source of truth for rejecting empty batches.

The transformation is implemented once and reused by direct tool actions and batch items. Finish schemas already require every property and do not need transformation.

## Runtime Contract

Constrained output will now contain explicit null placeholders for omitted top-level tool arguments. The parser will omit top-level entries whose value is null before constructing normalized tool actions.

Required arguments remain non-null in the generated schema. Parser-side required-argument validation remains authoritative for repaired or unconstrained model output. Nested nulls are not removed: recursively deleting them would corrupt legitimate JSON values, especially `json_filter` predicates.

Examples:

```json
{"action":"grep","pattern":"planner","path":null,"glob":null,"ignoreCase":null,"literal":null,"context":null,"limit":null}
```

normalizes to:

```json
{"action":"tool","tool_name":"grep","args":{"pattern":"planner"}}
```

An empty batch remains invalid at runtime:

```json
{"action":"tool_batch","calls":[]}
```

## Testing

Development follows red-green-refactor TDD.

Schema tests will prove:

- every direct-action and batch-item property appears in `required`;
- originally required properties are not nullable;
- originally optional properties accept null through `anyOf`;
- enum and unconstrained optional schemas retain their non-null constraints;
- nested object properties and array items are normalized recursively;
- `tool_batch.calls` has no `minItems`;
- `anyOf`, rather than `oneOf`, remains the only variant union.

Parser tests will prove:

- explicit top-level null placeholders are removed for direct summary and repo-search actions;
- the same normalization occurs inside `tool_batch` calls;
- nested null values are preserved;
- null or absent required repo-search arguments are rejected;
- empty batches are rejected.

Validation will run the focused tests first, then the repository typecheck and full test suite. Live exl3 validation will check direct calls, one- and two-item batches, rejection of a bogus batch item, rejection of the dangling-value form, and first-build time against the approximately 1.5-second baseline measured in the handoff.

## Risks and Controls

- **Nullable enum semantics:** wrapping the original schema in `anyOf` preserves enum validation while adding null.
- **Accidental nested-data loss:** null removal is deliberately top-level only.
- **Empty batch admitted by grammar:** existing parser validation rejects it deterministically.
- **Future tool schema regression:** recursive normalization happens centrally for every planner tool definition.
- **Formatron behavior differs from JSON Schema validators:** automated schema-shape tests are paired with live exl3 grammar validation.
