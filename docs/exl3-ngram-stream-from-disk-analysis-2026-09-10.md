# EXL3 `-ngr` / n-gram table streaming: path trace and bottleneck analysis

Date: 2026-09-10. Static trace only — nothing was executed, no benchmarks were run, no code changed.

Sources traced:

- ExLlamaV3 build-provenance tree `C:\AI\exl3\prod\src` (branch `deployment/pr341-zerocopy-on-dev`, v1.4.8)
- TabbyAPI checkout `C:\Users\denys\Documents\GitHub\TabbyAPI`
- Active model `D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6`

---

## 1. What `-ngr` is

`-ngr` is the short form of `--ngram_ram`, defined in ExLlamaV3's `model_init`:

- `exllamav3/model_init.py:65` — `parser.add_argument("-ngr", "--ngram_ram", action = "store_true", ...)`
- `exllamav3/model_init.py:216-217` — `if getattr(args, "ngram_ram", False): config.infer_params.ngram_stream_from_disk = False`

It is a **negation flag**: it does not turn streaming on, it turns streaming *off* and forces the whole hashed n-gram embedding table resident in system RAM.

Resolution chain, most specific first:

1. `NGramEmbedding(stream_from_disk = ...)` constructor arg (explicit `bool` wins) — `exllamav3/modules/ngram_embedding.py:96-98`
2. `config.infer_params.ngram_stream_from_disk` — read at load time, `ngram_embedding.py:212-215`
3. `EXL3_NGRAM_STREAM` env var, default `"1"` — `exllamav3/model/config.py:59`

So the **default is stream-from-disk = ON**. `-ngr` (or `EXL3_NGRAM_STREAM=0`, or `ngram_ram: true` in Tabby) is the only way off.

TabbyAPI surface:

- `common/config_models.py:317` — `ngram_ram: Optional[bool]`
- `backends/exllamav3/model.py:217-219` — sets `config.infer_params.ngram_stream_from_disk = False` and logs `Loading n-gram embeddings into system RAM (ngram_ram).`
- `config_sample.yml:172` — `ngram_ram: false`
- `docs/02.-Server-options.md:81` — documented as "tens of GB of system memory" to avoid "per-token disk reads"

Upstream's own guidance (`doc/env_vars.md`, `EXL3_NGRAM_STREAM`) claims streaming "costs little on SSD-class storage (decode is latency-tolerant at ~30 rows/token)" and that RAM mode is "worthwhile only when the table lives on high-latency storage (e.g. HDD)". The measured ~25% regression on an NVMe contradicts that assumption; §5 is about why.

Related debug knobs:

- `EXL3_NGRAM_PREFETCH` (default `1`) — `ngram_embedding.py:44`, disables worker-thread staging
- `EXL3_NGRAM_GATHER_PROF` — `exllamav3_ext/ngram_gather_win.cpp:59-63`, prints per-gather sync/pending read counts and worker/caller task split

---

## 2. The concrete numbers for this model

From `config.json` and the `ngram_embedding.safetensors` header:

| Quantity | Value |
|---|---|
| Architecture | `qwen4_exp` (Qwen3.8-Flash-Next), 48 layers |
| `ngram_size` | 3 |
| `heads_per_ngram` | 8 |
| `num_heads` = `(ngram_size - 1) * heads_per_ngram` | **16** |
| `ple_embed_dim` | 2560 → `head_dim` = 160 = `ROW_DIM` |
| `ple_layer_ids` | one entry → **exactly one PLE layer**, key `model.language_model.layers.1.ple` |
| Table rows | **320,001,536** |
| Packed row | `words_per_row(K=6)` = `1 + 160*6/16` = 61 × int16 = **122 bytes** |
| Table tensor | `[320001536, 61] I16`, data offsets `[5400, 39040192792]` |
| Table file | 39,040,193,720 B = **36.36 GiB** |

Two facts fall straight out of the header and matter later:

- **The table data starts at absolute file offset 5400**, which is *not* 4096-aligned (`5400 mod 4096 = 1304`). Combined with a 122-byte row pitch, no row is sector-aligned and ~3% of rows straddle a 4 KiB boundary.
- A row is 122 bytes but the streamed path reads with `FILE_FLAG_NO_BUFFERING`, so **the minimum physical read per row is 4096 bytes → ~33.6× read amplification** (8192 bytes for the ~3% straddlers).

Per-forward row counts:

- **Decode** (MTP dynamic drafting, max 1 draft token, `max_batch_size: 1`): `bsz(1) × out_len(2) × 16 heads` = **32 rows** ≈ 3,904 payload bytes ≈ **128 KiB of physical I/O in ~32 scattered reads**.
- **Prefill** (`chunk_size: 4096`): `4096 × 16` = **65,536 rows** ≈ **~256 MiB physical read per chunk**. A 180k-token prompt = 44 chunks ≈ **2.9M random reads, ~11 GiB read**.

The MTP head (`architecture/qwen4_exp_mtp.py:80-111`) contains **no** PLE layer, so drafting adds no gathers. One gather per main-model forward.

---

## 3. Load path

`NGramEmbedding.load()` — `exllamav3/modules/ngram_embedding.py:161-249`.

Common to both modes: `_load_aux()` (`ngram_embedding.py:126-152`) pulls the small side tensors — `head_bias [16,160] F16`, `head_offsets [16] I64`, `head_vocab_sizes [16] I64`, `layer_multipliers [3] I64`. Hash parameters stay on the **host** (token ids live there); only `head_bias` goes to the device. It then explicitly calls `stc.release_file()` because on Windows a buffered file object left open on the table file "throttles the unbuffered row gathers on the same file" (their comment, `ngram_embedding.py:146-151`).

Then it branches:

- **Streamed (default, `-ngr` absent)** — `ngram_embedding.py:216-238`. `mode = "trellis_disk"`. It takes `DiskTensorHandle`s from the loader, merges back-to-back shards into one handle spanning the whole table (this model is a single `.trellis` tensor, so one handle), and on Windows releases the loader's buffered handles. **No table bytes are read at load.**
- **Resident (`-ngr` present)** — `ngram_embedding.py:239-248`. `mode = "trellis_ram"`. Each shard is read via `stc.get_tensor(k, "cpu", no_defer = True)` and kept as separate CPU tensors — deliberately never `cat`ed, since that would transiently double a tens-of-GB footprint. **~36.4 GiB of pageable host RAM, plus 36.4 GiB read once at load.**

The disk handle is opened lazily by `DiskTensorHandle._ensure_open()` (`exllamav3/loader/safetensors.py:290-298`) as, on Windows, `_win_open_stream()` → `CreateFileW(..., FILE_FLAG_OVERLAPPED | FILE_FLAG_NO_BUFFERING)` (`safetensors.py:231-236`).

---

## 4. The per-forward path when streaming from disk

Call order for one main-model forward:

```
Model.forward / Model.prefill              model/model.py:207-208, 232-233
  └─ for m in self._get_prefetch_layers:   model/model.py:74-79  (caps["prefetch_ids"])
       m.prefetch(x, params)               modules/ple.py:342-351
         └─ NGramEmbedding.prefetch()      modules/ngram_embedding.py:412-437
  └─ forward_ls / prefill_ls
       ...  Embedding → ExpandStreams → block 0 → **PLELayer**  → blocks 1..47
                                                    │
       PLELayer.forward                    modules/ple.py:353-...
         └─ _prepare_ids  (ids → CPU int64, MM alias substitution)   ple.py:326-340
         └─ _state_history (prepend 2 carried ids from PLELayerState.id_state, CPU)  ple.py:314-325
         └─ forward_streams                ple.py:262-...
              └─ NGramEmbedding.forward    modules/ngram_embedding.py:439-...
```

### 4.1 `NGramEmbedding.forward` (`ngram_embedding.py:439-499`)

1. `ids = x.to("cpu", torch.int64).contiguous()` — already CPU in the hot path.
2. `_match(ids)` (`ngram_embedding.py:395-399`) — linear scan of queued prefetches comparing with `torch.equal`. Hit → reuse the staged `_PinSet` and `future.result()`. Miss → `_acquire_pin()` + **inline `_stage()`**.
3. `_stage()` (`ngram_embedding.py:375-393`):
   - `pin.event.synchronize()` — waits on the CUDA event recorded by the *previous* forward's H2D out of this pinned set.
   - `ext.ngram_hash_cpu(...)` — eos-segmented hashing + dedup, returns sorted unique row ids `U`, the inverse map, and each unique row's hash head.
   - `self._gather_rows(pin.uids[:U], pin.packed[:U])`.
4. `_gather_rows()` (`ngram_embedding.py:401-410`) → disk branch → `ext.ngram_gather_cpu(handle, abs_offset, row_bytes=122, uids, base, out)`.
5. Back in `forward`: `pin.packed[:U] → device (non_blocking)`, `pin.inverse[:n] → device`, `pin.heads[:U] → device`, then `ext.ngram_dequant(...)` on GPU (one block per row: unpack the tail-biting ring, decode the mul1 codebook, apply row scale + per-head bias), then `rows.index_select(0, inv_d).view(bsz, out_len, 2560)`.
6. A CUDA event is recorded on the current stream and stashed in the pin set; `pin.held = False`.

### 4.2 `ngram_hash_cpu` (`exllamav3_ext/ngram.cu:41-133`)

Single-threaded C++. Builds `std::vector<HK> hk(n)` with `n = bsz * seq * 16`, hashes `mixed = id[p]*m0`, `mixed ^= id[p-s]*ms` per `s`, `row = (mixed % vocab_size[h]) + offset[h]`, then a **full `std::sort` over all `n` entries** followed by a unique/inverse pass with `std::upper_bound` per unique row to recover the head. GIL is released.

### 4.3 `ngram_gather_cpu` — Windows (`exllamav3_ext/ngram_gather_win.cpp:270-350`)

GIL released. Sorted uids are coalesced into runs of *strictly consecutive* rows, then:

- **`n_runs <= 64` (decode-sized)** → `read_span_async(ctx, 0, U, depth = n_runs)` **on the calling thread** — i.e. the main Python/kernel-launch thread. No pool, no thread handoff.
- **`n_runs > 64` (prefill-sized)** → runs grouped into ≤64 span tasks handed to a persistent `GatherPool` of `min(32, max(4, hardware_concurrency))` = **24 detached threads** on this box, each running `read_span_async(..., depth = 8)`; the calling thread also drains tasks. Target ~512 outstanding NVMe commands.

`read_span_async` (`ngram_gather_win.cpp:110-208`) is where the actual I/O happens:

- Per in-flight slot: a thread-local auto-reset `HANDLE` event (`EventSet`, ≤64) and a thread-local 64 KiB `VirtualAlloc` bounce buffer (`BounceSet`).
- For each run: round the byte offset **down** to 4096, round the length **up** to 4096, `ReadFile(handle, bounce, rd_len, nullptr, &ov)` with the offset in the `OVERLAPPED`.
- Harvest loop: rebuild the handle array from the busy slots, `WaitForMultipleObjects(nh, hs, FALSE, INFINITE)`, **which returns exactly one completion**, `GetOverlappedResult(..., FALSE)`, `memcpy` the 122-byte payload out of the bounce slot at `pay_off`, free the slot, loop.

### 4.4 What `-ngr` changes

Everything above is identical in RAM mode **except** step 4: `_gather_rows` takes the `self.tables is not None` branch and does `torch.index_select(store, 0, seg, out = out[i0:i1])` — 32 random 122-byte host memory copies, a few microseconds, never blocking. The hash, the pin sets, the event sync, the H2D, the dequant kernel and the inverse gather are all the same.

**So the entire 25% delta is contained in `ngram_gather_cpu`.**

---

## 5. Bottleneck candidates, ranked

Sizing reference from `TabbyAPI/logs` (2026-09-04, this preset): ~120 T/s generate @ 2.2k ctx, ~37.7 T/s @ 81k ctx, ~85% draft acceptance with max 1 MTP draft → ~1.85 tokens/round → **~15 ms per decode round @ 2.2k**, ~49 ms @ 81k. A 25% regression is therefore **~3.8 ms per round attributable to 32 reads ≈ ~120 µs per read**. A Samsung 970 EVO Plus (D: is disk 0, NVMe, confirmed via `Get-PhysicalDisk`) has ~70-90 µs QD1 4K read latency and 300-400k IOPS at depth. **32 reads issued concurrently should cost ~100-150 µs total, not ~3.8 ms.** The measured cost therefore behaves as if there is *no* queue parallelism plus per-read overhead — that is the shape of the problem, and it points away from the SSD and toward the completion path.

### B1 (primary suspect) — the decode gather blocks the launch thread once per completion, on a CPU where every physical core is occupied by pinned, spinning MoE workers

The active preset offloads **415 MoE experts per layer** to CPU. The CPU MoE pool (`exllamav3_ext/cpu/moe_mul1.cpp:1707-1800`):

- **pins each worker to a physical core** (`pin_self` / `physical_core_order`, `EXL3_MOE_CPU_PIN`), and
- **busy-spins** between dispatches: `if (++idle < 65536) { cpu_pause(); continue; }` before parking on `WaitOnAddress`. The GPU→CPU handoff thread does the same (`cpu/moe_handoff.cu:237`).

Meanwhile the decode-sized gather runs `read_span_async` **inline on the main Python thread** (`ngram_gather_win.cpp:325-329`) and its harvest loop calls `WaitForMultipleObjects(..., INFINITE)` which **returns one completion at a time** (`ngram_gather_win.cpp:190-201`). For `U ≈ 32` unique rows that is **~32 block/wake cycles per decode round**, each of which must preempt a pinned spinner to get the main thread back on a core. On a 24-logical-core box with the MoE pool spinning, wakeup latency dominates NVMe latency by an order of magnitude, and `~32 × ~100 µs ≈ 3.2 ms` lands squarely on the observed regression.

RAM mode never blocks and never yields, so it pays none of this. This is the only mechanism found that both (a) lives entirely inside `ngram_gather_cpu` and (b) scales to milliseconds.

Cheap discriminators, in order:
1. Run with `EXL3_NGRAM_GATHER_PROF=1` and compare `sync` vs `pend` counts — a high `sync` count means the reads are completing inside `ReadFile` and the theory is wrong.
2. Run streamed with `EXL3_MOE_CPU_PIN=0` (or a preset with `moe_cpu_offload: 0`) and re-measure the RAM-vs-disk delta. If the delta collapses when the MoE pool isn't spinning/pinned, B1 is confirmed.

Fix directions (none applied): batch the harvest with an IOCP + `GetQueuedCompletionStatusEx` so 32 completions cost 1-2 wakeups; or spin-poll the `OVERLAPPED` status for the decode-sized path instead of blocking; or reserve one core from the MoE pool for the gather thread.

### B2 — decode never gets prefetch, so the gather is 100% exposed

`PREFETCH_MIN_TOKENS = 256` (`ngram_embedding.py:46`) and `prefetch()` returns early when `bsz * out_len < 256` (`ngram_embedding.py:428-430`). Decode is `1 × 2 = 2`. The stated rationale ("the thread hop per token measured as a net loss") is consistent with B1 being unrecognised: with a batched-completion harvest the inline path would be genuinely cheap; with the current harvest the thread hop trades one bad stall for another.

Structurally there is also very little to overlap with: **`ple_layer_ids` puts the PLE layer after only `Embedding → ExpandStreams → block 0`**, i.e. ~1/48th of the forward. Even prefill's prefetch (`~90 ms` cold per the in-code measurement) can only hide behind one block (~45 ms at the logged 1900 T/s prefill rate), so roughly half of the prefill gather is exposed too.

### B3 — `FILE_FLAG_NO_BUFFERING` defeats every cache, and the access pattern is highly repetitive

`_win_open_stream` opens the table unbuffered (`safetensors.py:231-236`). There is **no OS page cache, no user-space row cache, and no reuse of any kind** — the same row is re-read from the SSD every time it is touched. Token n-grams are strongly Zipfian: for `ngram_size = 3` the 16 rows per position are functions of `(t)`, `(t, t-1)` and `(t, t-1, t-2)`, and common bigrams/trigrams recur constantly within a generation. A modest resident cache (e.g. 2M rows ≈ 244 MB, or an LRU over 4 KiB sectors) would likely serve a large fraction of decode lookups at ~0 cost, without paying the 36.4 GiB of `-ngr`.

The unbuffered choice was made for a real reason — a long-lived buffered handle on the same file serializes the unbuffered gathers at QD 1 (`safetensors.py:308-315`, `ngram_gather_win.cpp:9-12`) — but the fix chosen (unbuffered everywhere) threw away all locality rather than isolating the reference path.

### B4 — ~33.6× read amplification, aggravated by an unaligned table offset

122-byte rows read through 4096-byte sector-aligned spans. Every decode round moves ~128 KiB off the SSD to use 3.9 KiB. Every prefill chunk moves ~256 MiB to use ~8 MiB. Bandwidth is not the binding constraint at decode, but it is a large multiplier on prefill (a 180k prompt streams ~11 GiB).

Two independent contributors:
- The table data offset is **5400**, not a multiple of 4096, so no row is ever sector-aligned and ~3% of rows straddle a boundary and cost 8192 bytes instead of 4096. Padding the tensor's data offset to 4096 in `conversion/ngram.py` would remove the straddlers for free.
- Runs are coalesced only on **strict adjacency** (`up[j] == up[j-1] + 1`, `ngram_gather_win.cpp:271-277` and `:135-137`). Two uids 3 rows apart sit in the same 4 KiB sector but are issued as two full reads of the same sector. Density makes this rare at decode, but merging uids within one sector is free and strictly reduces IOPS.

### B5 — prefill gather pool contends with the pinned MoE pool

`GatherPool` spawns `min(32, hardware_concurrency)` = **24 detached threads** (`ngram_gather_win.cpp:250-256`), unpinned, on a box where the MoE pool already owns all 12 physical cores and spins. During a chunked prefill of a CPU-offloaded model these two pools fight. Neither is aware of the other; the gather pool's width is chosen from `hardware_concurrency` with no account of `moe_cpu_offload`.

### B6 — `ngram_hash_cpu` is single-threaded and `O(n log n)` on the prefetch critical path

`exllamav3/exllamav3_ext/ngram.cu:97` sorts `n = bsz * seq * 16` 16-byte records. Prefill: 65,536 records per chunk, on the **single** `ThreadPoolExecutor(max_workers = 1)` prefetch worker (`ngram_embedding.py:432-433`), strictly *before* the gather it feeds. Millisecond-scale, so a few percent of a ~90 ms gather — but it directly delays the gather, and both a radix sort by hash and a parallel-for over `b, p` are straightforward. Irrelevant at decode (`n = 32`).

### B7 — one pin set at decode, so every step synchronizes on the previous step's CUDA event

`MAX_PIN_SETS = 2`, but `_acquire_pin` (`ngram_embedding.py:359-373`) returns `free[0]` and both sets are released at the end of every `forward` (`pin.held = False`), so at decode **only `self._pins[0]` is ever allocated and reused**. `_stage` therefore calls `pin.event.synchronize()` on the event recorded during the previous forward, at the very front of every step — a host↔device sync that clamps host run-ahead to ≤1 step.

Noted for completeness, **not** part of the 25%: this code path is identical in RAM mode. It is worth fixing only if kernel-launch run-ahead turns out to matter.

### B8 — minor

- `_match` (`ngram_embedding.py:395-399`) is a linear scan doing `torch.equal` on the id history per queued entry. Bounded by `MAX_PIN_SETS`, so ≤2 comparisons. Harmless.
- The harvest loop rebuilds the `hs[]`/`smap[]` arrays over all `depth` slots on **every** completion (`ngram_gather_win.cpp:194-198`) — `O(depth²)` scanning per gather. Microseconds, dwarfed by B1.
- `read_rows` / `read_range` (`safetensors.py:322-379`) allocate a `bytearray` per run and use a transient buffered handle. These are the *reference* paths (`fetch_rows`, tests, `forward_reference`) and are not on the hot path — but note `_win_open_ref` opens a **buffered** handle per call, which is exactly the thing the fast path is documented to be poisoned by. Any accidental use of `fetch_rows` during inference would degrade subsequent streamed gathers for "a few seconds".

---

## 6. Summary

- `-ngr` / `--ngram_ram` / Tabby `ngram_ram: true` / `EXL3_NGRAM_STREAM=0` all set `config.infer_params.ngram_stream_from_disk = False`, which flips `NGramEmbedding` from `trellis_disk` to `trellis_ram`. Cost: **36.4 GiB of host RAM** for this model.
- With it **off** (the default), every main-model forward gathers `bsz × seq × 16` 122-byte rows out of a 36.4 GiB file with unbuffered overlapped `ReadFile`s into pinned staging, then does one H2D + a GPU trellis dequant. Decode = **32 scattered reads per round**, fully inline on the main thread, at model layer 1 of 48.
- The RAM/disk delta is confined entirely to `ngram_gather_cpu`. Every other stage — hashing, staging, H2D, dequant, inverse gather — is byte-identical between modes.
- The regression is far larger than the raw NVMe latency of 32 concurrent 4 KiB reads. The leading explanation is **B1**: a one-completion-at-a-time `WaitForMultipleObjects` harvest running inline on the launch thread, on a machine where the 415-expert CPU-MoE pool pins and spins on every physical core, so each of ~32 completions pays scheduler-wakeup latency instead of device latency. **B3** (no cache of any kind for a highly repetitive access pattern) is the second structural cause and the cheapest large win.
- Suggested order of investigation, cheapest first: `EXL3_NGRAM_GATHER_PROF=1` to read the sync/pending split; then re-measure the RAM-vs-disk delta with `EXL3_MOE_CPU_PIN=0` to isolate spin/pin contention; then A/B `EXL3_NGRAM_PREFETCH=0/1`.

## 7. Not verified

- No measurements were taken; all timings above are either quoted from in-tree comments (`~78 µs/row cold`, `~90 ms per 4096-token chunk`, `~5 ms page-cache-warm`), from `TabbyAPI/logs`, or derived arithmetically from the file layout. The ~25% figure is the user's, and B1 is a hypothesis with a stated discriminator, not a confirmed root cause.
- The Windows branch of `physical_core_order` carries an in-tree `UNVERIFIED` marker (`cpu/moe_mul1.cpp:1633-1635`): it was never compile-tested upstream. If pinning is silently not taking effect on this box, B1's contention story weakens (though the 24 spinning workers alone still saturate the machine).
- Whether the currently active preset runs with `ngram_ram` true or false was not determined; `docs/exl3-backend-setup.md` says the table is streamed, while `TabbyAPI/logs/2026-09-08_15-05-25_541762.log:3` shows the RAM path being taken.
