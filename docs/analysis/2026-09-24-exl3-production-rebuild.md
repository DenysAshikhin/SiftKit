# EXL3 local production rebuild, 2026-09-24

## Source and wheel

The new isolated checkout at `C:\AI\exl3\prod-20260924\src` is
`a20bdd74d13a0f1975a1dd92d2cd5f5c28a41fd3`: upstream `dev`
`e3b52f474d53b3727ecc64171a03a9157f388efc` plus [#389](https://github.com/turboderp-org/exllamav3/pull/389),
which includes [#386](https://github.com/turboderp-org/exllamav3/pull/386). The merge
resolves the loader and memory-helper conflicts while retaining upstream's
integrated-GPU behavior. The source tree is clean.

The installed cp314 wheel is
`C:\AI\exl3\packages\prod\a20bdd7\exllamav3-1.5.1-cp314-cp314-win_amd64.whl`,
SHA-256 `4c936802ab693a01504d50b0623ca5a158437f9cf2ac682c4cfbc2b6e58a7eda`.
The wheel, build manifest, source hash, and wheel hash are retained together.
The independent runtime is `C:\AI\exl3\prod-20260924\venv-runtime`; Python
3.14.7, Torch 2.14.0+cu132, CUDA build 13.2, RTX 4090. Installed critical
members and extension matched the wheel. `pip check` passed.

## Why #386 remains

On clean upstream `dev`, all five #386 regression tests failed; after the
merge all five passed. Upstream still counts temporary CPU-MoE prefill buffers
as if they remain allocated after autosplit. #386 subtracts that temporary
allocation from the persistent budget. It affects the saved Flash Next preset
with 411 CPU experts per layer; Swift has no CPU-MoE experts.

## Validation

Focused EXL3 tests passed: 26 in the source checkout and 26 against the
installed wheel. The locally applicable source suite passed with 740 tests,
10 skipped, and 8 subtests passed. The unrestricted suite requires GPUs 1/2
and external model fixtures; its ten FLA parity failures reproduced on the
previous production environment with the identical test file.

Both saved presets completed long prompts through the independent runtime
interpreter on the RTX 4090. Metrics are PyTorch CUDA bytes:

| Preset | Prompt / completion tokens | Steady allocated | Peak allocated | Peak reserved | Retries / OOM |
|---|---:|---:|---:|---:|---:|
| Swift 5 bpw, 149k/Q8/MTP3/vision | 140018 / 39 | 23118033920 | 23853245952 | 23913824256 | 0 / 0 |
| Flash Next, 170k/Q8/411 CPU experts/vision | 124852 / 128 | 23685314560 | 24140595712 | 24291311616 | 0 / 0 |

The local persisted `Server.Engines.Exl3.PythonPath` now points to
`C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe`. A read-back
comparison verified that every other config field, including the active
Swift preset, was unchanged. The status server was not running during the
switch, so the next launch will capture the new interpreter. The old
`C:\AI\exl3\prod` environment remains intact for rollback.

SiftKit validation passed: `npm test` reported 4,213 passed and 4 skipped;
`npm run typecheck`, `npm run lint`, `npm run build`, and
`git diff --check` passed.
