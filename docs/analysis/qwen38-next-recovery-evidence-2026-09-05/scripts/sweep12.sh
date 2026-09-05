#!/bin/bash
cd "C:/Users/denys/Documents/GitHub/SiftKit"
R=.scratch-qwen38-replay/run3.sh
M='D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6'
bash $R e3-quiet-exit "" -m $M -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -sg -max_length 256
bash $R e4-quiet-exit-loadfail "" -m $M -mcs 410 -mct 12 -cs 155136 -chunk_size 4096 -max_length 8192
echo SWEEP12_DONE
