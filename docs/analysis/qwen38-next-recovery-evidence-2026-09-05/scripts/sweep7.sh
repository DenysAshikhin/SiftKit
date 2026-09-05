#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
S=.scratch-qwen38-replay
until [ -f $S/logits_old.pt ]; do sleep 5; done; sleep 8
echo "=== new-engine logits check"
export PYTHONPATH='C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3'
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTORCH_ALLOC_CONF='backend:native'
export EXL3_LOAD_ARENA=1 EXL3_MOE_STREAM_T=4
'C:/envs/rl313-turbo/Scripts/python.exe' $S/logits_check.py --check $S/logits_old.pt \
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' -mcs 410 -mct 12 -cs 32768 > $S/logits_new.log 2>&1
echo "logits check exit $?"; tail -3 $S/logits_new.log
R=$S/run2.sh
bash $R n1-new-prefill "" -sg -max_length 8192
bash $R n2-new-prefill-prof "EXL3_MOE_STREAM_PROF=1" -sg -max_length 8192
bash $R n3-new-prefill-w4-64 "EXL3_MOE_CPU_WSLOTS=4 EXL3_MOE_CPU_WSLOT_MB=64" -sg -max_length 8192
bash $R n4-new-decode-memops0 "EXL3_MOE_MEMOPS=0" -spf -max_length 2048
bash $R n5-new-full-memops0 "EXL3_MOE_MEMOPS=0" -max_length 8192
echo SWEEP7_DONE
