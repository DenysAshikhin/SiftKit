# Bounded pinned pieces

Execute locally with TDD after the active Windows matrix. No SiftKit, worktrees,
consumer migrations, public entrypoints, arena edits, model-order changes or tuning flags.

Parent initially `perf/staging-worker-pool`; measure against both that parent and baseline.
If only the combination wins, retain one minimal combined branch rather than claim a
prerequisite is independently faster. Pool acceptance still requires complete measurements.

1. Add failing geometry and real native producer/consumer tests. Cover two fixed-stride
   pieces, partial pieces, held-buffer backpressure, guard bytes, queue and uint32 wrap,
   concurrent compute, helper reuse, shutdown while blocked and stale native ABI rejection.
2. Detect the smallest available L3 domain with validated Windows topology / Linux sysfs.
   Allocate two pieces, each whole-expert aligned within one third of that domain and the
   existing GPU slot limit. A single expert is the minimum. Derive geometry from the largest
   stream-eligible expert; allocate no pieces if none are eligible. No machine/model table.
3. Replace whole-slot staging with pieces. `job.seq` is the first global piece counter.
   Fixed byte stride is shared across every layer/device. Experts per piece are the stride
   divided by the packed expert byte count; `topk` remains a compute-only field.
   Replace the obsolete `prev_seq` field with the already-known packed expert byte count;
   this avoids another native lookup API. Native waits for piece reuse, copies, then publishes `counter + 1` to the batch's ready
   flag. GPU waits/copies/releases each piece into its existing batch destination before
   existing batch unswizzle/ready/compute. All comparisons and counters wrap at uint32.
4. Replace two native staging-layout arguments with one piece-size argument, migrating
   every caller. Old binaries fail argument validation. Keep existing flag-bank offsets;
   remove obsolete whole-slot views/sequence state and document the revised protocol.
5. Rebuild and pass native/correctness tests on both OSes, including GPU ordered copies.
   Inspect the full diff; verify unchanged arena and GPU batch/compute code. Commit locally.
6. Collect five full PP/decode runs per OS plus matched parent controls. Do not accept a
   PP gain with material decode regression. Linux load failure remains explicitly blocked
   until a working, authorized environment is available. Document rejected experiments.
7. Attribute dependent components with two removal comparisons, also five runs per OS:
   (a) keep the piece protocol/geometry but restore upstream per-call staging threads;
   (b) keep the ring/pool but use one largest eligible expert per pinned buffer, removing
   cache detection and its policy completely. The latter is the natural minimum complete
   ring, with no chosen machine-specific byte budget. Remove a component if it contributes
   no demonstrated improvement to the combination. These experimental branches are not
   separate deliverables unless they independently earn retention.

8. Conditional follow-up identified during measurement: combined ring runs 1–3 measured
   1245.98 / 1271.42 / 1233.43 PP32k, then run 4 dropped to 1024.19. Smaller pieces also
   reduce the existing probe's transfer size; its 256-iteration warmup cap can therefore
   shorten warmup further. This is a hypothesis for variation, not an established cause.
   After the current matrix finishes, apply the already-tested probe-retry candidate to
   the ring on `perf/staging-piece-ring-probe`, preserving piece views and native identity.
   Pass probe and ring tests, then measure five interleaved parent/ring+probe pairs. Keep
   retries only if this conditional comparison demonstrates a benefit. Do not introduce
   a forced threshold, a new tuning flag, or changes to the benchmark entrypoint.
