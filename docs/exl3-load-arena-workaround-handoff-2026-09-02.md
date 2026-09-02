# EXL3 load-arena workaround handoff (2026-09-02)

**Status:** active and temporary. The implementation is isolated in commit `41e67c55` on
`main`; this handoff is uncommitted. SiftKit-managed TabbyAPI launches force
`EXL3_LOAD_ARENA=0`. External TabbyAPI/EXL3 servers are unaffected.

## What the setting changes

EXL3 1.4.6 enables its load arena by default. During deferred module loading, tensors up to
16 MiB are normally carved from shared 128 MiB per-device slabs. This reduces CUDA allocator
fragmentation for models with very many small tensors, especially high-expert-count MoE models.

`EXL3_LOAD_ARENA=0` disables that slab allocator and restores one CUDA caching-allocator
allocation per tensor. The upstream implementation reads the variable once when constructing
the safetensors collection:

```python
self.arena_enable = os.environ.get("EXL3_LOAD_ARENA", "1") != "0"
```

The local upstream documentation is
`D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench\doc\env_vars.md`, under
`EXL3_LOAD_ARENA`.

## Why the workaround is needed

The active SiftKit preset exceeded the RTX 4090's usable allocation during the final main-model
module with EXL3's default load arena enabled:

| Setting | Value |
|---|---|
| EXL3 | `1.4.6+unified.1` |
| Model | `3.8_27b_4.9bpw` |
| Context | `155000` tokens |
| Cache | `155136` tokens |
| Drafting | built-in MTP |
| Vision | enabled, weights kept in system RAM |
| GPU | RTX 4090, 24 GiB |

The failed SiftKit inference run was
`002705db-9081-42ac-8b70-9f636267de12` at 2026-09-02 08:39 local time. Vision loaded 30/30,
the MTP draft loaded 3/3, and the main model stopped at 66/67 with:

```text
RuntimeError: Insufficient VRAM in split for model and cache
```

The exception came from `exllamav3/model/model_ls.py:222`. The same large-context preset had
also failed on EXL3 1.4.4, so this is not evidence that 1.4.6 introduced the underlying capacity
problem.

An A/B changing only `EXL3_LOAD_ARENA` to `0` loaded the model successfully. After SiftKit was
updated to inject the value itself, a normal launch with the caller variable explicitly absent
produced run `b66b4cba-0654-4f5a-ab50-5405c393bf2d`: vision 30/30, draft 3/3, main model 67/67,
status `ready`, and HTTP 200 from `/v1/models` and `/v1/model`.

This proves the flag is an effective workaround for this workload. It does **not** yet prove the
precise allocator-level failure mechanism; no allocation trace compared arena-on and arena-off.

## Where SiftKit applies it

[`src/inference-presets/exl3-preset-adapter.ts`](../src/inference-presets/exl3-preset-adapter.ts)
adds the literal to `Exl3LaunchEnvironmentSchema` and `buildLaunchEnvironment()`. The managed
runtime merges that validated environment after its parent environment, so SiftKit always passes
`0` to the child even if the parent defines another value.

Coverage is in:

- [`tests/managed-tabby.test.ts`](../tests/managed-tabby.test.ts): verifies the real managed child
  receives the complete environment.
- [`tests/model-preset-adapters.test.ts`](../tests/model-preset-adapters.test.ts): verifies both MTP
  and non-speculative EXL3 launch environments.

No setting was added to the user configuration. There is one behavior and no compatibility path:
all SiftKit-managed EXL3 launches use per-tensor allocation until this workaround is removed.

## When it is safe to remove

Do not remove the workaround solely because a newer EXL3 version exists. Remove it only after an
upstream candidate passes the exact workload with `EXL3_LOAD_ARENA` absent or set to its default
`1`:

1. The `3.8_27b_4.9bpw` model loads at `max_seq_len=155000` and `cache_size=155136`.
2. Vision reaches 30/30, MTP draft reaches 3/3, and the main model reaches 67/67.
3. `/v1/models` and `/v1/model` return HTTP 200 and SiftKit records the startup run as `ready`.
4. One representative inference request completes without CUDA allocation errors.
5. Repeat once after a clean process restart to exclude allocator state left by a prior run.

Record the first upstream EXL3 version/commit that passes and link its issue or patch here. No
upstream issue or patch identifier was known when this handoff was written.

## Efficient removal

The workaround is deliberately six insertions across three files. Remove it in one small change:

1. In `src/inference-presets/exl3-preset-adapter.ts`, delete the temporary-workaround comment,
   the `EXL3_LOAD_ARENA: z.literal('0')` schema field, and the
   `EXL3_LOAD_ARENA: '0'` builder field.
2. Delete the `EXL3_LOAD_ARENA: '0'` expectation once from `tests/managed-tabby.test.ts` and twice
   from `tests/model-preset-adapters.test.ts`.
3. Rebuild and run the focused contract tests:

   ```powershell
   npm run build:test
   npm test -- model-preset-adapters managed-tabby
   ```

4. Run the repository gates and rebuild the runnable output:

   ```powershell
   npm run typecheck
   npm run lint
   npm run build
   ```

5. Ensure the validation shell is not masking the result, then perform the live acceptance check:

   ```powershell
   Remove-Item Env:EXL3_LOAD_ARENA -ErrorAction SilentlyContinue
   npm run start:status:stable
   ```

The workaround is isolated in commit `41e67c55`, so `git revert 41e67c55` is the fastest
mechanical removal. Prefer an explicit removal commit after the live acceptance check when
retaining this handoff as historical evidence.

## Roll back a failed removal

If the exact live workload again fails at model load, stop the validation instance, restore the
two adapter entries plus the three test expectations, run `npm run build`, and restart SiftKit.
If the removal was already committed, revert the removal commit. Do not reduce context, disable
vision/MTP, or change cache quantization in the same validation run: those changes would hide
whether the upstream patch actually replaced this workaround.

## Validation state at handoff

- Focused EXL3 tests: 32/32 passed.
- `npm run build`, `npm run typecheck`, and `npm run lint`: passed.
- Full suite: 3,521 passed, 3 skipped, 2 failed. Both failures are unrelated stale schema-version
  assertions expecting version 55 while the current schema is 56:
  `assistant-migration.test.ts` and `runtime-db-schema-v51.test.ts`.
- Live 155k managed launch with no caller override: passed.
- Validation processes were stopped; ports 4765, 6876, and 8098 had no listeners.
