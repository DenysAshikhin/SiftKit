#!/bin/bash
# Merged engine-zero-copy benchmarks. Same perf args as n5/v1.
R="C:/Users/denys/Documents/GitHub/SiftKit/docs/analysis/qwen38-flash-next-engine/scripts/run5.sh"
A="-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192"
bash "$R" b1-merged-defaults "" $A
bash "$R" b2-merged-t4 "EXL3_MOE_STREAM_T=4" $A
echo SWEEP_DONE
