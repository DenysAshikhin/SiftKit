# EXL3 Penalty-Range Benchmark Script Design

## Goal

Provide one PowerShell entry point that compares EXL3 sampling throughput with an effectively
unbounded penalty range and the shipped 4096 setting without requiring users to reconstruct a
long command.

## Design

Add `scripts/exl3-penalty-range-benchmark.ps1` as a thin wrapper around EXL3's existing
`examples/chat.py`.

The script will:

- use the local Python 3.13 environment, EXL3 checkout, and 4.7-bpw Qwen3.5 model by default;
- validate those three paths before starting;
- run `penalty_range` values `100000000` and `4096` sequentially with otherwise identical
  sampling and cache arguments;
- label each arm before launching it;
- offer exact 24k, 64k, and 128k input-context fixtures stored beside the script;
- accept the same choices non-interactively through `-Context`;
- pipe the selected fixture to both arms through stdin, avoiding Windows command-line limits;
- stop with an error if either child process exits unsuccessfully.

`100000000` is used instead of raw EXL3's `-1`: TabbyAPI maps `-1` to `100000000`, while passing
`-1` directly to EXL3 disables the penalty sampler stages.

## Scope

The wrapper will not reimplement generation, parse TPS output, or manage SiftKit processes.

## Verification

After implementation:

1. PowerShell syntax parsing must succeed.
2. Each fixture plus Qwen3.5 chat framing must tokenize to its labeled context size.
3. `-Context 24k` must load the model and complete both labeled arms.
4. Each child must exit with code zero and print tokens/second.
5. The existing unrelated working-tree changes must remain untouched.
