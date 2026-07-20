# Llama Model-List Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed llama.cpp startup recognize the current object-valued `/v1/models` response as ready.

**Architecture:** Extend `LlamaCppClient`'s runtime schema with one model-reference shape shared by `data` and `models`. Normalize identifiers inside the existing client and leave managed lifecycle polling unchanged.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js test runner, `tsx`.

## Global Constraints

- Use TDD: observe the regression test fail before changing production code.
- Keep protocol parsing inside `LlamaCppClient`; do not add a second readiness endpoint.
- Use runtime-schema-derived types and no type assertions, `any`, or non-null assertions.
- Preserve existing loading, timeout, and non-success HTTP behavior.

---

### Task 1: Normalize current llama.cpp model references

**Files:**
- Modify: `tests/llm-protocol.test.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts`

**Interfaces:**
- Consumes: `LlamaCppClient.probeModelsAtBaseUrl(baseUrl: string, timeoutMs?: number): Promise<LlamaCppModelProbeResult>`.
- Produces: the same public interface, with `models` populated from string or object entries containing `id`, `model`, or `name`.

- [ ] **Step 1: Write the failing protocol regression test**

Add this test beside the existing model fallback coverage in `tests/llm-protocol.test.ts`:

```ts
test('llama client accepts current object-valued model lists', async () => {
  const client = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({
      models: [{
        name: 'Qwen3.6-27B-IQ4_NL_mtp.gguf',
        model: 'Qwen3.6-27B-IQ4_NL_mtp.gguf',
      }],
      data: [{ id: 'Qwen3.6-27B-IQ4_NL_mtp.gguf' }],
    }),
    jsonResponse({
      models: [{ name: 'fallback-name.gguf' }],
    }),
  ]));

  const current = await client.probeModelsAtBaseUrl('http://127.0.0.1:8097');
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.models, ['Qwen3.6-27B-IQ4_NL_mtp.gguf']);

  const fallback = await client.probeModelsAtBaseUrl('http://127.0.0.1:8097');
  assert.deepEqual(fallback.models, ['fallback-name.gguf']);
});
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run:

```powershell
npx tsx --test --test-name-pattern "llama client accepts current object-valued model lists" .\tests\llm-protocol.test.ts
```

Expected: FAIL with a Zod error at `models.0`, reporting that a string was expected and an object was received.

- [ ] **Step 3: Implement model-reference schema and normalization**

Replace the model-list schema in `src/llm-protocol/llama-cpp-client.ts` with:

```ts
const RawModelReferenceSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
});
const RawModelEntrySchema = z.union([z.string(), RawModelReferenceSchema]);
const RawModelListResponseSchema = z.object({
  data: z.array(RawModelReferenceSchema).optional(),
  models: z.array(RawModelEntrySchema).optional(),
});
type RawModelEntry = z.infer<typeof RawModelEntrySchema>;
```

Add this identifier normalizer near the schema:

```ts
function getRawModelIdentifier(entry: RawModelEntry): string {
  return typeof entry === 'string'
    ? entry
    : entry.id || entry.model || entry.name || '';
}
```

In `probeModelsAtBaseUrl`, normalize both arrays and retain `data` precedence:

```ts
const dataModels: string[] = [];
for (const model of response.body.data || []) {
  const identifier = getRawModelIdentifier(model);
  if (identifier.trim()) dataModels.push(identifier);
}
const fallbackModels: string[] = [];
for (const model of response.body.models || []) {
  const identifier = getRawModelIdentifier(model);
  if (identifier.trim()) fallbackModels.push(identifier);
}
return {
  statusCode: response.statusCode,
  rawText: response.rawText,
  models: dataModels.length > 0 ? dataModels : fallbackModels,
};
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npx tsx --test .\tests\llm-protocol.test.ts
npx tsx --test .\tests\runtime-status-server.lifecycle.test.ts
```

Expected: both test files pass with zero failures.

- [ ] **Step 5: Run static and full validation**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0; the complete suite reports zero failures.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- src/llm-protocol/llama-cpp-client.ts tests/llm-protocol.test.ts
git commit -m "fix: accept current llama model lists"
```

- [ ] **Step 7: Verify the live preset transition**

Start the stable server:

```powershell
npm run start:status:stable
```

Using `PUT /config`, confirm every `Server.ModelPresets.Presets[].NumCtx` is `30000`, begin with `ActivePresetId=exl3-3-6-27b`, then set `ActivePresetId=qwen3-6-27b-q4-thinking`.

Expected: the first switch request completes successfully, returned configuration has `ActivePresetId=qwen3-6-27b-q4-thinking`, `/v1/models` reports `Qwen3.6-27B-IQ4_NL_mtp.gguf`, and no concurrent-switch 503 occurs.
