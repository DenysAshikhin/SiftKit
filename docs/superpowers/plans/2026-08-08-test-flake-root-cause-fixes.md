# Test flake root-cause fixes plan

1. Flush wait ownership
   - Change queue tests and inference-run integration tests to use an idle wait with no private millisecond deadline.
   - Remove timeout arithmetic and the timeout error from `InferenceRunFlushQueue.waitForIdle`.
   - Verify focused queue and inference-run tests, including repeated concurrent execution.

2. Managed Tabby log readiness
   - Extend the fake Tabby fixture with a configurable delayed drafting announcement.
   - Add a failing regression where HTTP readiness precedes the MTP marker.
   - Make the runtime await the marker inside the preset health-check window.
   - Verify positive stdout/stderr, delayed, missing-marker, reuse, and restart cases.

3. Live guard ownership
   - Add a failing child-process regression proving a locally owned guarded port is allowed.
   - Track current-process TCP listener ownership in the preload guard.
   - Exclude default guarded ports from free-port helpers used for parent-to-child handoff.
   - Verify all guard tests and the speculative-fallback E2E repeatedly.

4. Dashboard startup rollback
   - Add failing regressions for exceptions after fixture resource acquisition.
   - Route failed startup through the same idempotent cleanup as normal close.
   - Ensure fake-server listen errors reject and trigger cleanup.
   - Verify fixture cleanup and model-queue HTTP suites.

5. Independent validation
   - Replace the SSE cross-boundary timestamp assertion with observable event-order assertions.
   - Replace temp-directory child startup/exit sleeps with explicit process events.
   - Run focused tests and stress loops for all three prior flakes.
   - Run the standard `npm test` multiple times without lowering concurrency.
   - Run `npm run typecheck` and `npm run lint`.
   - Check for orphan Node test/server processes and leftover managed temp directories.
