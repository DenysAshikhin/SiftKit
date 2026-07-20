# EXL3 Runtime Corrections Design

## Goal

Correct three architectural problems in the per-preset inference runtime: preserve native EXL3 request features, authenticate Tabby lifecycle operations, and prevent the Tabby runtime from holding or starting with a llama preset.

## Request compatibility

EXL3 supports OpenAI `tools` and `response_format` inputs. SiftKit will stop deleting those fields in both internal inference requests and `/v1/chat/completions` passthrough requests. Backend-specific translation remains limited to parameter names and fields that genuinely have no Tabby equivalent, such as llama slot and prompt-cache controls.

The Qwen 3.6 model-folder `chat_template.jinja` returns tool calls as `<tool_call>` XML while leaving the OpenAI `tool_calls` response field null. Existing SiftKit XML parsing remains responsible for internal tool execution. SiftKit will not add a per-preset compatibility toggle or infer behavior from model names.

`response_format` remains caller-controlled. Thinking can consume the token budget before constrained content is emitted, so SiftKit will not silently disable thinking or rewrite caller token limits.

The request translation rules will have one typed implementation shared by the internal request builder and inference passthrough. The unused `BackendCapabilities` metadata will be removed rather than retained as a second policy source.

## Tabby lifecycle authentication

`Server.Engines.Exl3` gains an `AdminApiKey` string. It is an engine-level secret because SiftKit manages one Tabby engine and the credential authorizes engine lifecycle operations, not a model preset.

`TabbyModelClient` will accept the engine credential at construction and send `Authorization: Bearer <AdminApiKey>` on current-model probes, loads, and unloads. An empty value sends no authorization header for local Tabby installations with authentication disabled.

Inference passthrough preserves the caller's `Authorization` header independently. A remote SiftKit request first wakes the active preset using SiftKit's configured Tabby admin credential, then forwards the caller's original authorization to the inference endpoint. Caller credentials are never promoted to lifecycle credentials.

Lifecycle failures remain explicit. Tabby `401` and `403` responses surface as load, unload, or probe errors and prevent SiftKit from reporting the preset ready.

## Runtime lifecycle

`ManagedTabbyRuntime` will no longer accept an initial model preset. Construction requires only `Exl3EngineConfig` and its authenticated `TabbyModelClient`.

`startProcess()` will no longer be part of the public managed-runtime interface. `ensurePresetReady(preset)` is the only model-start entry point: it validates `preset.Backend === 'exl3'`, records the validated preset, reconciles process identity, starts or probes Tabby, and loads the requested model.

Process startup helpers become private to each concrete runtime. The coordinator continues to operate exclusively through `ensurePresetReady`, `unloadPreset`, and `stopProcess`. Therefore, a server whose active preset is llama constructs an inert EXL3 runtime with no invalid preset state; the first EXL3 request supplies the validated target preset before any EXL3 process or endpoint access.

## Data flow

1. A local or remote chat/tokenization request reaches SiftKit.
2. The runtime coordinator resolves the active preset and calls its runtime's `ensurePresetReady`.
3. For EXL3, the runtime uses `AdminApiKey` to probe and, when necessary, load the model.
4. SiftKit translates only backend-specific parameter names and forwards the request, including `tools`, `response_format`, and the caller's authorization.
5. Existing response handling parses Qwen `<tool_call>` XML for SiftKit-owned tool loops.
6. Idle expiry unloads the EXL3 model using the same engine credential; the next model request repeats the authenticated wake path.

## Testing

Implementation follows red-green-refactor cycles. Tests will cover:

- internal EXL3 requests retaining `tools` and `response_format`;
- passthrough EXL3 requests retaining those fields while removing llama-only controls;
- authenticated model probe, load, and unload requests;
- empty credentials omitting the authorization header;
- `401` and `403` lifecycle failures remaining errors;
- construction while the active preset is llama followed by an EXL3 wake;
- rejection of a llama preset before any Tabby network or process operation;
- existing concurrent wake, idle unload, remote wake, rollback, typecheck, lint, build, and full test behavior.

Changed runtime files should approach complete branch coverage, including authentication omission/error branches and process-start failure transitions.

## Scope

This change does not add model-name detection, compatibility shims, legacy config migration, automatic thinking changes, response rewriting for generic non-SiftKit clients, or multiple Tabby engine credentials.
