#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
S=.scratch-qwen38-replay
export PYTHONPATH='D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench'
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTORCH_ALLOC_CONF='backend:native'
export EXL3_LOAD_ARENA=1 EXL3_MOE_STREAM_T=4
'C:/envs/rl313-turbo/Scripts/python.exe' $S/logits_check.py --save $S/logits_old.pt \
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' -mcs 410 -mct 12 -cs 32768 \
  > $S/logits_old.log 2>&1
echo "exit $?"; tail -4 $S/logits_old.log
