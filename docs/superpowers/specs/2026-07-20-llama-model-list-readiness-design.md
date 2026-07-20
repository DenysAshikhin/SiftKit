# Llama Model-List Readiness Design

## Problem

Managed llama.cpp startup uses `GET /v1/models` to decide when a launched server is ready. Current llama.cpp returns both OpenAI-style `data` entries and object-valued `models` entries. SiftKit validates `models` as `string[]`, so the otherwise healthy HTTP 200 response fails schema validation. The startup loop converts that validation error to `offline` and continues until `StartupTimeoutMs` expires.

## Design

Update the llama.cpp model-list response schema to accept the model reference objects returned by current llama.cpp. Normalize model identifiers from both `data` and `models`, preferring identifiers from `data` when present. Keep startup readiness based on the existing `/v1/models` status code so this fix does not introduce a second lifecycle endpoint or change loading-state handling.

The normalization will remain inside `LlamaCppClient`; managed runtime code will continue consuming the existing `probeModelsAtBaseUrl` result.

## Error Handling

Malformed model entries remain schema errors. Network failures, timeouts, non-success status codes, and llama.cpp loading responses retain their current behavior. A valid HTTP 200 response containing object-valued model references becomes `ready` instead of being misclassified as `offline`.

## Testing

Add a regression test using the observed current llama.cpp response shape, including object-valued `models` entries and OpenAI-style `data` entries. Verify the probe returns HTTP 200 and the expected model identifier. Run focused protocol and managed-lifecycle tests, then the complete test suite and build.

Finally, start SiftKit with the persisted presets and verify an EXL3 to `qwen3-6-27b-q4-thinking` switch completes with all presets configured for a 30,000-token context.

## Scope

This change does not add request queuing, dashboard retries, or a new health-check endpoint. The concurrent-switch 503 is expected to disappear for this reproduction because the first switch will settle normally.
