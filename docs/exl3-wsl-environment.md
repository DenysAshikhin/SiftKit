# Retained EXL3 upstream WSL2 environment

Created 2026-09-05 for [the controlled performance investigation](analysis/2026-09-05-performance-controlled-followup.md).
The user explicitly requested retention. This is an upstream-only benchmark environment;
the Windows production engine remains separate.

## Inventory

- WSL distribution: `SiftKit-EXL3-Perf-20260905` (version 2).
- Ubuntu Base 24.04.4, amd64; WSL 2.2.4.0, kernel `5.15.153.1-microsoft-standard-WSL2`.
- Virtual disk: `C:/Users/denys/Documents/GitHub/SiftKit/.scratch-performance-followup/wsl/ext4.vhdx`.
  **Retained despite the parent directory's scratch name. Do not delete this disk or its parent
  during scratch cleanup.** All other temporary files and the Windows reference checkout were
  moved to the Recycle Bin at closeout; only `wsl/` remains. Observed disk-file size:
  14,455,668,736 bytes. The model weights are not duplicated inside it.
- Upstream source/build: `/opt/exllamav3`, detached at
  `c93f3c61c35ff300df49205f6f60e716172d1398` (upstream `dev` when checked).
- Patched source/build (added 2026-09-06): `/opt/exllamav3-zc`, branch `engine-zero-copy` at
  `ba5473b` (was `4bc002a`; the two later commits are Python and docs only) from the fork
  `DenysAshikhin/exllamav3`, in-place extension
  `exllamav3_ext.cpython-313-x86_64-linux-gnu.so` SHA-256
  `6beb1d575822fd61b589ff8325ed8104b86d1caa7291a5ab01a9fd6771ddc9c2`, built with the same
  settings as the upstream build plus `ninja` on `PATH` (`/opt/exl3/bin`). Select it with
  `PYTHONPATH=/opt/exllamav3-zc`; the editable install still points at `/opt/exllamav3`.
  Its arena needs `/dev/shm` larger than the default 54 GB: `mount -o remount,size=100G
  /dev/shm` before a run (not persistent). Results are in
  [the PR validation record](analysis/2026-09-06-zero-copy-pr-validation.md).
- Python environment: `/opt/exl3`, Python 3.13.14, torch `2.13.0+cu132`, editable upstream
  `exllamav3==1.4.7` from `/opt/exllamav3`.
  `/opt/bootstrap` contains `uv` for managing this environment. The installed package snapshot
  is `/opt/exl3-freeze.txt`. Main Windows-matched dependencies: FLA/fla-core 0.5.0,
  transformers 5.15.0, tokenizers 0.22.2, numpy 2.2.6, safetensors 0.8.0. Linux Triton is
  3.7.1, versus `triton-windows` 3.7.1.post27 on Windows.
- CUDA toolkit: `/usr/local/cuda-13.2`, nvcc 13.2.86, development libraries 13.2.2;
  compiler and development libraries only.
  The GPU driver is Windows NVIDIA 610.47, exposed by WSL; no Linux GPU driver is installed.
- Model weights: existing Windows directory
  `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`, exposed as
  `/mnt/d/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`. No duplicate model is required.
- Host `C:/Users/denys/.wslconfig`: `memory=108GB`, `swap=0`. This file did not exist before
  the investigation. The limit fits the benchmark's RAM embeddings and CPU experts; it applies
  to the WSL2 VM globally, not solely to this distro. Memory is allocated on demand.

## Lifecycle

Inspect: `wsl --list --verbose`.

Open: `wsl -d SiftKit-EXL3-Perf-20260905`.

Stop after use: `wsl --terminate SiftKit-EXL3-Perf-20260905` (retains files).

Do not use `wsl --unregister` for routine cleanup; it deletes the distro. Keep the source
revision, installed package inventory, extension hash, benchmark command, and observed results
in the linked investigation record whenever this environment changes.

## Verified build

Source import: `/opt/exllamav3/exllamav3/__init__.py`.

Extension: `/opt/exllamav3/exllamav3_ext.cpython-313-x86_64-linux-gnu.so`.

Extension SHA-256: `fef264470a70d0f84db2dd4850b1973a4b8b3efe6dcafc9bf92b2be272f8a78f`.

`setup.py build_ext --inplace` exited 0. Build settings: `CUDA_HOME=/usr/local/cuda-13.2`,
`TORCH_CUDA_ARCH_LIST=8.9`, `MAX_JOBS=12`. The source remote points to official upstream;
there is no Git alternates dependency on the temporary Windows checkout. Import and torch
CUDA initialization succeeded; `lscpu` exposes 12 physical cores and 24 logical CPUs.

Editable installation reuses the in-place extension (`EXLLAMA_NOCOMPILE=1`, setuptools
`editable_mode=compat`); imports were verified from `/opt`, outside the source checkout.
All 50 shared non-engine package names have matching Windows/Linux versions after alignment.
`git fsck --full` passed. The upstream pool test passed (1 test, 14 dependency deprecation
warnings, 58.12 s). Two full benchmark runs exited 0; detailed numbers and remaining limits
are in the linked investigation record. The final profiled repeat also exited 0 with empty
stderr; its 32k prefill was 1045.25 tok/s and steady decode about 25–26 tok/s with memops 0.
The extension hash remained unchanged after editable installation and validation.
The unused bootstrap Python 3.13.15 and download caches were cleaned; Python 3.13.14,
the environment, source, compiled extension, build objects, and workload cache are retained.
The distro was stopped at closeout on September 6; GPU memory returned to 0 MiB.

Reproduction command (PowerShell):

```powershell
wsl -d SiftKit-EXL3-Perf-20260905 --cd /opt/exllamav3 --exec env `
  PYTHONPATH=/opt/exllamav3 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 `
  EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=0 PYTORCH_ALLOC_CONF=backend:native `
  /opt/exl3/bin/python eval/perf.py `
  -m /mnt/d/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 `
  -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 32768
```

## September 7 grouped-prefill prototype

A third independent checkout, `/opt/exllamav3-online-20260907`, is based on
`c6c45b13f2bb070a2c86fae59f3d7bfe4db9ae94` plus the ring/grouped-prefill prototype.
The two existing checkouts above are preserved. It built with CUDA 13.2, detected
GPU architecture 8.9 and MAX_JOBS=12. Extension SHA-256:
`324202855778cfca89d6e02425d705ae4f57005626ffcf30cdecc8509fb6bcfd`.

43 selected tests passed, including the native CPU pool; the subsequent shutdown
regression also passed separately. Full-model ring and 10 GB resident measurements
failed during loading near the Windows commit limit, before throughput measurement.
No Linux throughput result is claimed. No host/pagefile/THP settings were changed;
`/dev/shm` was temporarily remounted to 100G for the runs. The distro is stopped.
See [the result and capacity record](analysis/2026-09-07-grouped-prefill-results.md)
and [the detailed worklog](analysis/2026-09-07-online-prefetch-worklog.md).
