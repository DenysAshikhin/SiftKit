#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
R=.scratch-qwen38-replay/run3.sh
M='D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6'
bash $R m1-new-155k-c2048 "EXL3_MOE_MEMOPS=0 PYTORCH_ALLOC_CONF=backend:cudaMallocAsync" -m $M -mcs 410 -mct 12 -cs 155136 -chunk_size 2048 -max_length 8192
bash $R m2-new-155k-c4096 "EXL3_MOE_MEMOPS=0 PYTORCH_ALLOC_CONF=backend:cudaMallocAsync" -m $M -mcs 410 -mct 12 -cs 155136 -chunk_size 4096 -max_length 8192
echo SWEEP9_DONE
