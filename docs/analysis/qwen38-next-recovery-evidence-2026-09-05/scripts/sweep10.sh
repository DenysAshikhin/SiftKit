#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
R=.scratch-qwen38-replay/run3.sh
M='D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6'
bash $R v1-new-defaults-prof "EXL3_MOE_STREAM_PROF=1" -m $M -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192
bash $R v2-new-155k-c4096-fail "" -m $M -mcs 410 -mct 12 -cs 155136 -chunk_size 4096 -max_length 8192
echo SWEEP10_DONE
