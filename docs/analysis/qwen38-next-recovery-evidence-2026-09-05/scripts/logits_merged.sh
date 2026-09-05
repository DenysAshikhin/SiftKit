#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
EV="docs/analysis/qwen38-next-recovery-evidence-2026-09-05"
export PYTHONPATH='C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3'
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTORCH_ALLOC_CONF='backend:native'
export EXL3_LOAD_ARENA=1 EXL3_MOE_STREAM_T=4
'C:/envs/rl313-turbo/Scripts/python.exe' $EV/scripts/logits_check.py --save $EV/logits-equivalence/logits_merged.pt \
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' -mcs 410 -mct 12 -cs 32768 \
  > $EV/logits-equivalence/logits_merged.log 2>&1
echo "logits exit $?"; tail -3 $EV/logits-equivalence/logits_merged.log
for r in logits_old logits_old2 logits_new; do
  echo "merged vs $r:"; 'C:/envs/rl313-turbo/Scripts/python.exe' $EV/scripts/compare_pt.py $EV/logits-equivalence/$r.pt $EV/logits-equivalence/logits_merged.pt
done
