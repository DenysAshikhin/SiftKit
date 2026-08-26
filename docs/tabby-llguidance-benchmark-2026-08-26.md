# TabbyAPI upstream-merge A/B benchmark (2026-08-26)

Decision record for the deferred question from
`docs/superpowers/plans/2026-08-26-tabby-upstream-merge-and-env-rename.md`:
after the merge dropped the Formatron grammar filter cache (`04f32a4`) in favor of
upstream's uncached LLGuidance backend, is an LLGuidance-side cache needed?

**Verdict: no cache needed. Gate closed.** Uncached LLGuidance schema compilation
(~0-15 ms) is cheaper than Formatron's *cached* path, and per-token constrained
decoding got ~50% faster on a complex schema. Unconstrained pp/decode is unaffected,
as expected (grammar code never runs without `json_schema`).

## Setup

- Builds: merged `92cbf9f` (LLGuidance, no cache) vs pre-merge `907c954` (Formatron + `schema_filter_cache`).
- Model: `D:\personal\models\elx3\3.8_27b_4.4bpw`, exllamav3 `1.4.4+unified.1` (same wheel for both builds), RTX 4090, 32768 ctx, cache_mode 8,8, draft disabled, `output_chunking` off.
- Method: streamed `/v1/completions`, greedy (`temperature=0, top_k=1`), fresh server start per build. TTFT = wall time to first content chunk with client-side read buffering disabled; token counts via `/v1/token/encode`; unique prompt prefixes defeat the prefix cache on prefill runs.

## Unconstrained pp/decode

| Metric | Pre-merge | Merged |
|---|---|---|
| Prefill t/s, 13,348-token prompt (x3) | 2124 / 2156 / 2143 | 2023 / 2128 / 2134 |
| Decode t/s, 512 tokens (x3) | 50.1 / 50.2 / 50.3 | 50.3 / 50.2 / 50.3 |

Parity. The single low merged prefill run (2023) is a first-touch effect.

## Grammar (json_schema) TTFT

Unconstrained baseline TTFT with the same prompt: ~0.085-0.10 s on both builds.

| Case | Pre-merge (Formatron + cache) | Merged (LLGuidance, no cache) |
|---|---|---|
| First-ever constrained request (one-time engine init) | 2.32 s | 1.70 s |
| Same schema, repeats | 0.089-0.155 s (cache hit) | 0.085-0.16 s |
| New complex schema, first request | 1.96 s | 0.18 s |
| Fresh schema every request (guaranteed miss, x5) | 0.49-0.51 s each | 0.086-0.101 s each |
| First schema again after a schema switch | 0.089-0.133 s | 0.085-0.104 s |

Formatron paid ~410 ms compile per new schema (the cost its cache amortized);
LLGuidance compiles in ~0-15 ms, below run-to-run noise.

## Constrained decode throughput

| Schema | Pre-merge | Merged |
|---|---|---|
| Simple person object | 56-70 t/s | 55-62 t/s |
| Complex nested object (enums, nested objects, arrays) | 26-34 t/s | 40-51 t/s |

LLGuidance's per-token logit masking is ~50% faster on the complex schema.

## Follow-up unlocked

`FormatronSchemaLowerer` (`src/providers/formatron-schema-lowering.ts`) existed to
work around Formatron's missing optional-property support (force-require all
properties, null-wrap optionals). LLGuidance handles optionals natively and this
benchmark shows no perf reason to pre-lower, so the lowering can be removed and
standard JSON-Schema optional semantics restored.
