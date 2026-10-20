# Session drift review — October 20, 2026

Scope: the 37 files changed for the web chat model selector, their immediate routing/storage callers, and fixtures consuming the changed contracts. These are session-introduced issues or existing test shortcuts made worse by the change. The earlier terminal lifecycle and historical cache-field problems are outside this drift-fix scope.

## 1. Preference saves could race submissions and overwrite each other

- **What it is** — the preference methods replaced at `dashboard/src/hooks/useChatSessions.ts:457` independently saved and applied full session responses, without a shared pending-request guard.
- **Purpose** — save a per-chat model override.
- **Why it's an issue** — incomplete behavior and duplicated save logic: concurrent changes could restore stale preferences, and immediate submissions could use the previous model.
- **The fix** — replaced the separate preference methods with `updateSessionPreferences` and one pending-request guard. Preference controls, submissions, retry, queued Force/edit/remove, condensation and deletion wait until it settles. Tests cover model-first and thinking-first saves, success and failure; queue forcing remains available during active runs.
- **Context** — the former method exposed no pending state:

  ```ts
  const response = await updateChatSession(selectedSessionId, { modelPresetOverrideId });
  applySessionResponse(response);
  ```

## 2. Durable choices silently accepted missing migrations

- **What it is** — the persisted choice at `packages/contracts/src/chat.ts:324` and `packages/contracts/src/chat-recovery.ts:48` was formerly optional.
- **Purpose** — represent inheritance while avoiding fixture migrations.
- **Why it's an issue** — missing and explicit inheritance were indistinguishable; this violated the requirement that missed migrations fail loudly.
- **The fix** — durable choices now require a shared nullable reference schema. Schema 81→82 explicitly updates old settings and journal events, verifies source digests, and recomputes changed digests atomically. Concrete fixtures were migrated; no runtime compatibility reader remains.
- **Context** — the old contract masked omission:

  ```ts
  modelPresetOverrideId: z.string().trim().min(1).nullable().optional()
  ```

## 3. Request validation had two parallel paths

- **What it is** — `src/status-server/routes/chat.ts` parsed the new field separately from an older permissive update normalizer; `dashboard/src/api.ts` repeated the payload type. Their shared replacement is `packages/contracts/src/chat.ts:336`.
- **Purpose** — add the model field with minimal changes.
- **Why it's an issue** — duplicate boundary definitions and unvalidated IO: malformed adjacent fields were ignored, allowing a partially valid update to save.
- **The fix** — one strict `ChatSessionUpdateRequestSchema` validates the entire request and supplies the inferred browser payload type. Removed the old parser and handwritten type. HTTP regressions cover invalid fields and unknown keys.
- **Context** — the split parsing was:

  ```ts
  const updateRequest = parseChatSessionUpdateRequest(parsedBody);
  const modelSelection = ChatSessionModelSelectionSchema.safeParse(parsedBody);
  ```

## 4. The browser independently derived the default model

- **What it is** — `dashboard/src/hooks/useChatController.ts` calculated the default from operation/config fields, while `ChatTab.tsx` supplied a “No model” fallback. Resolution now belongs to `src/status-server/chat-session-response.ts:20`.
- **Purpose** — label the inheritance option.
- **Why it's an issue** — duplicated routing policy could drift from the session response, and the fallback concealed incomplete metadata.
- **The fix** — the server resolves and returns a required `defaultModelPreset` identity. The browser renders that label directly. The redundant prop, client resolution and fallback were removed.
- **Context** — the former calculation was:

  ```ts
  selectedChatPreset?.modelPresetId
    ?? dashboardConfig?.Server.ModelPresets.ActivePresetId
    ?? null
  ```

## 5. Chat intent mapping was copied across inference paths

- **What it is** — previews, admission and captions each rebuilt the mapping now owned by `src/status-server/chat-model-selection.ts:4`, with differently named choice fields.
- **Purpose** — forward the override through existing launch paths.
- **Why it's an issue** — DRY violation: a future path could omit the override, as caption inference initially did.
- **The fix** — `src/status-server/chat-model-selection.ts:4` owns the mapping. Preview, admission, caption and display resolution use it. Mode substitution passes the selected session consistently.
- **Context** — repeated mappings had this shape:

  ```ts
  { presetId, model: null, modelPresetId: session.modelPresetOverrideId }
  ```

## 6. Tests could pass without proving each dispatch

- **What it is** — the routing E2E repeatedly checked the last recorded execution; an adjacent session fixture used `z.custom<ChatSession>` to brand partial objects. Dispatch validation now starts at `tests/preset-model-routing.e2e.test.ts:57`.
- **Purpose** — reuse an existing harness and keep fixture setup short.
- **Why it's an issue** — a prior successful execution could satisfy the next assertion, and branded fixtures bypassed the new contract.
- **The fix** — each operation must produce a completed decoded terminal; assertions verify the exact dispatch count, order, submitted task and model. The fixture now uses the real stored-session schema.
- **Context** — the weak assertion was:

  ```ts
  assert.equal(engine.executions.at(-1)?.modelPresetId, ALTERNATE_MODEL_PRESET_ID);
  ```

## 7. Migration tests pinned an unrelated latest version

- **What it is** — three migration tests repeated `assert.equal(CURRENT_SCHEMA_VERSION, 81)`. Behavioral checks remain at `tests/runtime-db-schema-chat-progress-delta.test.ts:70`, `tests/runtime-db-schema-chat-status-narration.test.ts:41`, and `tests/runtime-db-schema-chat-submissions.test.ts:19`.
- **Purpose** — update old tests after the new column migration.
- **Why it's an issue** — hardcoded change detectors required edits for every later migration without validating additional behavior.
- **The fix** — removed the redundant literals. The tests retain checks that the opened database reaches the current schema and preserves/transforms the expected rows and digests.
- **Context** — the removed assertion was:

  ```ts
  assert.equal(CURRENT_SCHEMA_VERSION, 81);
  ```

Validation: backend 4,292 passed and 4 skipped; dashboard 660 passed; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. Build retains the existing bundle-size warning. Live browser rendering and real inference were not exercised. No commits were created.
