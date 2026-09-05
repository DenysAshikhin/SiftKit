#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
R=.scratch-qwen38-replay/run4.sh
M='D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6'
bash $R e1-noise-attrib "" -m $M -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -sg -max_length 256
bash $R e2-noise-memops1 "EXL3_MOE_MEMOPS=1" -m $M -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -sg -max_length 256
echo SWEEP11_DONE
