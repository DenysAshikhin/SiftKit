#!/bin/bash
# usage: run2.sh <name> "<extra env assignments>" <perf args...>
set -u
NAME="$1"; EXTRA="$2"; shift 2
cd "C:/Users/denys/Documents/GitHub/SiftKit"
EV="docs/analysis/qwen38-next-recovery-evidence-2026-09-05"
export PYTHONPATH='C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3'
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
export PYTORCH_ALLOC_CONF='backend:native'
export EXL3_LOAD_ARENA=1 EXL3_MOE_STREAM_T=4
for kv in $EXTRA; do export "$kv"; done
env | grep -E '^(PYTHONPATH|PYTORCH_ALLOC_CONF|EXL3_)' > "$EV/$NAME-env.txt"
echo "args: $*" >> "$EV/$NAME-env.txt"
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,clocks.sm,clocks.mem,pstate,power.draw,temperature.gpu --format=csv -lms 1000 > "$EV/$NAME-gpu.csv" 2>/dev/null &
GPUPID=$!
powershell -NoProfile -Command "while(\$true){ \$t=Get-Date -Format o; \$c=(Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples[0].CookedValue; \"\$t,\$([math]::Round(\$c,1))\" }" > "$EV/$NAME-cpu.csv" 2>/dev/null &
CPUPID=$!
echo "start $(date -Iseconds)" > "$EV/$NAME-status.txt"
'C:/envs/rl313-turbo/Scripts/python.exe' .scratch-qwen38-replay/wrap_perf.py \
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' \
  "$@" \
  > "$EV/$NAME.txt" 2> "$EV/$NAME-stderr.txt"
RC=$?
echo "exit_code $RC" >> "$EV/$NAME-status.txt"
echo "end $(date -Iseconds)" >> "$EV/$NAME-status.txt"
kill $GPUPID $CPUPID 2>/dev/null
echo "exit_code=$RC"
