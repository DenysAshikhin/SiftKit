#!/bin/bash
# Pure upstream c93f3c6 benchmarks. Same perf args as n5/v1.
R="C:/Users/denys/Documents/GitHub/SiftKit/docs/analysis/qwen38-flash-next-engine/scripts/run5.sh"
A="-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192"
bash "$R" u1-upstream-defaults "" $A
bash "$R" u2-upstream-t4 "EXL3_MOE_STREAM_T=4" $A
bash "$R" u3-upstream-memops0 "EXL3_MOE_MEMOPS=0" $A
bash "$R" u4-upstream-t4-memops0 "EXL3_MOE_STREAM_T=4 EXL3_MOE_MEMOPS=0" $A
echo SWEEP_DONE
