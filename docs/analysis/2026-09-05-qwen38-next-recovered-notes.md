# Recovered Flash-Next investigation notes

Recovered on 2026-09-05 from the local Claude session. Original timestamp: 2026-09-02T19:58:24.826Z.

Source: [session record 507](C:/Users/denys/.claude/projects/c--Users-denys-Documents-GitHub-SiftKit/d08a0cf6-e417-423e-ba51-425a7537bd4d.jsonl:507). This is the earlier investigation's write-up, preserved as historical evidence. Proposed code changes below were recommendations, not proof that those changes were installed. Fresh reproduction is recorded separately.

The old prefill commands omitted cache size; the benchmark default was 32768, not the 155136 allocation tested on September 4. The old experiments used 4096-token chunks.

---

Here is a write-up you can paste to the exllamav3 author. It covers the three findings that change numbers, with the evidence and the concrete fix for each.

---

**Environment:** RTX 4090 (PCIe Gen4 x16), Ryzen 9 7900X, 128 GB DDR5-5600, Windows 11, dev tip f3f7e42. Model: Qwen-Flash-Next 4.05 bpw, 512 experts, `--moe_cpu_split 410 --moe_cpu_threads 12`, chunk 4096. All numbers from `eval/perf.py --skip_gen`.

**1. The pinned-to-device bandwidth probe measures a sleeping PCIe link, so `stream_t` is inflated at random.**

`MoeCpuHost._ensure_stream_state` in `exllamav3/model/moe_cpu_host.py` does two warm-up copies and one timed 16 MiB copy, then sets `stream_t = max(16, 16 * 25 / bw)`. On Windows the NVIDIA driver drops the link to Gen1 after 6 to 9 s idle regardless of the power plan, and retraining to Gen4 takes 250 to 400 ms of sustained traffic. Two copies are not enough, so the probe reads whatever the link happens to be at that moment. Observed on identical runs: 26.7 GB/s (stream_t 16), 6.8 GB/s (stream_t 58, the Gen2 plateau during retrain), and in a standalone test 3.4 GB/s straight from Gen1. At stream_t 58, prefill dropped from 901 to 414 tok/s.

Fix: warm the link for a wall-clock budget, then take best-of-N. A 250 ms warm followed by best-of-8 read 26.3 to 26.7 GB/s after a 30 s idle under both Power saver and Ultimate Performance, where the current probe read 3.4.

```python
probe = min(self.wslot_size, 16 << 20)
ev0, ev1 = torch.cuda.Event(enable_timing = True), torch.cuda.Event(enable_timing = True)
bw = 0.0
with torch.cuda.stream(st["copy_stream"]):
    # An idle PCIe link sits at Gen1 and only retrains under sustained traffic;
    # two warm-up copies measure the sleeping link, not the working one.
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < 0.25:
        st["vram_slots"][0][:probe // 2].copy_(self.wviews[0][:probe // 2], non_blocking = True)
        st["copy_stream"].synchronize()
    for _ in range(8):
        ev0.record(st["copy_stream"])
        st["vram_slots"][0][:probe // 2].copy_(self.wviews[0][:probe // 2], non_blocking = True)
        ev1.record(st["copy_stream"])
        ev1.synchronize()
        bw = max(bw, probe / (ev0.elapsed_time(ev1) * 1e-3) / 1e9)
```

**2. The CPU tail serializes ahead of the streamed batches, and the default `stream_t` of 16 leaves too much on it.**

In `_submit_prefill_streamed`, the tail is issued through `_issue_compute` with a 4-slot window, and the done-flag waits land on the compute stream before the streamed batches. With stream_t 16 on a 4096-row chunk, about 560 rows per layer stay on the CPU across ~9 jobs, and only the last 4 overlap with streaming. Measured with CUDA events: the compute stream waits ~23 ms per layer on the tail, about 1.1 s per chunk. Forcing `EXL3_MOE_STREAM_T=4` cuts the tail to ~80 rows, the wait to under 1 ms, and raises prefill from 960 to 1053 tok/s at 4096 and 994 to 1098 at 8192. Short prompts gain more: 331 to 404 tok/s at 1024.

Fix options: lower the default threshold for x16 links (4 was strictly better here and the link has headroom, streamed traffic only reached ~12 GB/s of 26), or enqueue the tail done-waits after the streamed batches so the tail overlaps all of the streaming rather than the last 4 jobs.

**3. The n-gram row gather blocks the forward at layer 1 instead of overlapping layer 0.**

`NGramEmbedding.forward` in `exllamav3/modules/ngram_embedding.py` runs hash, gather, and upload synchronously when the PLE layer executes. The gather itself is fine: 105 to 130 ms per 4096-token chunk at ~370k rows/s on a 970 EVO Plus, close to the drive's ceiling. But the GPU idles for that whole window. Disk mode lands at 999 to 1016 tok/s versus 1053 from RAM, a 4 to 5% tax that is almost entirely this stall. The row ids depend only on token ids, so the hash and gather can start on a worker thread at the top of the forward and the PLE layer can wait on the result. Layer 0 takes about 80 ms, so most of the gather hides behind it.

Minor, related: any buffered open of the table file, even one already closed, throttles the unbuffered gathers to 11 to 30k rows/s for the next ~3 s (the cache-map coherency effect the comments in `ngram_gather_win.cpp` already describe). `_load_aux` reads the head offsets, vocab sizes, multipliers, and bias through the buffered loader, and `DiskTensorHandle._win_open_ref` is buffered too. Reading those through the unbuffered handle, or writing the aux tensors to a separate file at conversion, closes the hole. Low priority in practice because 47 layers load between those reads and the first prompt.

---

Results for reference, all Ultimate Performance power plan on a quiet machine:

| Config | 4096 | 8192 |
|---|---|---|
| default probe, stream_t 16, n-gram in RAM | 956 to 961 | 983 to 994 |
| stream_t 4, n-gram in RAM | 1053 | 1098 |
| stream_t 4, n-gram from SSD | 999 to 1016 | 1028 to 1047 |
| probe misread 6.8 GB/s, stream_t 58 (Power saver) | 414 | 432 |
