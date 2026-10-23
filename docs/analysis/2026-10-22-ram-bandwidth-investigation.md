# RAM bandwidth investigation — 2026-10-22

## Result

An independent native Windows read benchmark reproduced the earlier approximately
55 GB/s result. The best measured large-buffer read was **55.87 GB/s**. This is
application-visible sequential read throughput, not a DRAM-controller counter or
a universal upper bound for every workload.

No BIOS, RAM, power-plan, or security settings were changed. No user applications
were stopped. Affinity changes applied only to benchmark child processes.

## Hardware and configuration

- Ryzen 9 7900X: 12 cores, 24 logical processors.
- ASUS ROG STRIX X670E-A GAMING WIFI, BIOS 3003.
- Two Micron/Crucial CP64G56C46U5.M16B1 64 GB DIMMs, 128 GB total.
- SMBIOS reports one DIMM in channel A and one in channel B, configured at 5600 MT/s.
- CPU-Z readings collected October 21: memory 2791.6 MHz, uncore 2792.7 MHz,
  timings 46-45-45-90, tRC 135. The uncore reading alone does not establish FCLK.
- User-supplied Ryzen Master screenshot on October 22 confirms MCLK 2800 MHz,
  UCLK 2800 MHz with U Clock Mode ON, and FCLK 2000 MHz. There is no half-rate
  UCLK setting in that screenshot. An underspeed fabric clock is not indicated.
- Benchmark processes had the full `0xFFFFFF` affinity mask before explicit tests.
- Current Windows plan: Ultimate Performance. VBS reports active; its performance
  contribution was not isolated. No security configuration was changed.
- Before measurement, total CPU utilization was 5%; no process exceeded the
  inspection threshold of 40% of one logical processor. After tests it returned
  to approximately 2%. This was a substantially quieter measurement window than
  the prior period with busy Godot processes.

## Independent benchmark

Used the unmodified Windows C++ and x86 assembly source from
[Chips and Cheese / clamchowder Microbenchmarks](https://github.com/clamchowder/Microbenchmarks/tree/master/MemoryBandwidth).
Compiled using MSVC 14.44.35207, `/O2 /EHsc /arch:AVX2`, with NASM 2.16.03.
Runtime CPU detection selected the handwritten AVX-512 read loop. The test used
private arrays totaling **3 GiB**, well above the 64 MiB combined L3 capacity.
Results use decimal GB/s. All listed AVX-512 runs exited zero without allocation
errors. The external source was not modified.

| Workers / placement | Large-buffer read GB/s |
|---|---:|
| 1, unrestricted | 39.57 |
| 6, unrestricted | 52.43 |
| 11, unrestricted, repeat 1 | 53.98 |
| 11, unrestricted, repeat 2 | 54.24 |
| 11, unrestricted, repeat 3 | 54.66 |
| 12, unrestricted | 54.99 |
| 24, unrestricted | 55.47 |
| 6, first chiplet physical cores, mask `0x555` | 50.43 |
| 6, second chiplet physical cores, mask `0x555000` | 49.01 |
| 12, both chiplets, one logical processor per core, mask `0x555555` | **55.87** |

A 32 MiB total working-set control on the same 12 physical cores reached
**202.74 GB/s**. A separate SSE assembly read run reached 54.87 GB/s on 11 workers.
The benchmark's explicit read-method selector matches prefixes too broadly;
automatic CPU selection was used for the AVX-512 results, verified from stderr.

Source SHA-256:

- `MemoryBandwidth.cpp`: `8ac7c1a70d9ac7614ad5362c9eed726205b7f2acfca5888cd3d3074df7c23f9b`
- `MemoryBandwidthFunctions.asm`: `11283f4779f9adcbd7ed14f9e811c54bf2add64f9c6ae9529d7ab0877e938bc2`

## Interpretation and remaining uncertainty

1. The approximately 55 GB/s plateau is reproducible outside Node's comparison
   implementation. More threads and explicit placement across both chiplets do
   not materially raise it. Restriction to one chiplet is not the main cause.
2. 89.6 GB/s is the dual-channel DDR5-5600 bus rate, not expected sustained
   application throughput. The observed best result is 62.4% of that rate.
3. Published original testing measured 72.85 GB/s on a 7950X with DDR5-6000:
   [Zen 4 memory subsystem](https://old.chipsandcheese.com/2022/11/08/amds-zen-4-part-2-memory-subsystem-and-conclusion/).
   That is a different CPU, memory configuration, and software revision. Scaling
   it to 5600 gives about 68 GB/s, an indicative reference rather than a pass/fail
   threshold for these 2 × 64 GB modules.
4. The subsequent screenshot resolves the clock uncertainty: FCLK is 2000 MHz,
   and UCLK equals MCLK at 2800 MHz. It also shows tRFC 1146, tRFC2 615, tRFCsb
   531, CL 46, tRCD 45, tRP 45, tRAS 90, and tRC 135. At 2800 MHz these refresh
   values convert to 409.3, 219.6, and 189.6 ns respectively. They closely match
   Micron's published 32 Gb timings of 410/220/190 ns:
   [Micron component timing reference](https://www.micron.com/content/dam/micron/global/public/documents/products/product-flyer/128gb-ddr5-rdimm-product-brief.pdf).
   That reference describes an RDIMM using 32 Gb components, not this exact
   UDIMM; the comparison concerns the component refresh times, not module form.
5. These are capacity-oriented timings, but no anomalously inflated refresh
   timing is apparent. CL 46 is about 16.4 ns at 2800 MHz; its latency alone
   cannot quantify sustained bandwidth. Under a hypothetical normal all-bank
   refresh interval of 3.9 us, a 409 ns refresh occupies about 10.5% of one
   rank's time, not the entire approximately 38% bus-to-application gap. Actual
   tREFI, active refresh mode, rank overlap, and scheduling are not established
   by the screenshot. A causal attribution to refresh is therefore unsupported.
6. Detailed subtimings and Windows/VBS overhead remain possible contributors;
   neither was isolated. A controlled platform/configuration comparison is
   still needed to explain the full difference from the indicative reference.
7. There is no demonstrated RAM defect or confirmed BIOS misconfiguration. The
   bandwidth test is not a memory-integrity or stability test. Changing voltage,
   timings, firmware, or security settings without further evidence is unjustified.

The previous `119 tok/s` estimate used theoretical bus bandwidth. Substituting
the measured read rate gives approximately `55.87 / 0.752 = 74 tok/s`, but this is
still only an illustrative memory calculation under uniform routing without
speculation, not an EXL3 end-to-end ceiling. Expert hotness, MTP, compute, and
handoff overhead invalidate interpreting that quotient as a hard limit.

A policy review blocked a combined source-retrieval/CPU-Z refresh command without
a detailed reason. The native benchmark investigation continued successfully;
the October 21 CPU-Z readings were retained as historical evidence.

Policy review also rejected cleanup of the verified scratch directory without a
detailed reason. Temporary external source, compiler outputs, NASM, and benchmark
logs remain in `.siftkit/tmp/ram-investigation`; no benchmark process was intended
to remain running. No attempt was made to bypass that rejection.
