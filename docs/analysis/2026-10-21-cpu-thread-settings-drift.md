# CPU thread settings: session drift review

Scope: the session's General settings UI, shared configuration contract, managed Tabby runtime, restart coordinator, documentation, tests (including review fixes), and their immediate callers. Reviewed against the supplied AGENTS.md and `C:/Users/denys/.claude/CLAUDE.md`; no project CLAUDE.md exists. Seven confirmed findings, ranked below; there were not thirteen substantiated findings. All seven were corrected. Context snippets show the offending session implementation; file:line references identify the corrected code.

## 1. A failed DOM assertion exhausted system virtual memory

- **What it is** — the new interaction test compared a React-backed DOM element directly with null inside a retrying assertion (`dashboard/tests/settings-cpu-threads.test.tsx:37`).
- **Purpose** — wait until saving removes the unsaved-changes indicator.
- **Why it's an issue** — failure formatting traversed the DOM/React object graph instead of reporting a bounded scalar. Windows recorded resource-exhaustion events with Node consuming 152,193,970,176 and 162,775,814,144 bytes of virtual memory during these UI test attempts. This violated the requirement for straightforward tests and safe validation.
- **The fix** — compare a boolean, await initial UI readiness, and remove diagnostic code. The focused test then completed in milliseconds. Final validation ran sequentially with two backend workers, one dashboard worker, and a 2 GiB Node heap cap per process.
- **Context** — the problematic assertion, now replaced with a boolean comparison:

  ```ts
  await waitFor(() => assert.equal(screen.queryByText(/[Uu]nsaved/u), null));
  // Corrected:
  await waitFor(() => assert.equal(screen.queryByText(/[Uu]nsaved/u) === null, true));
  ```

## 2. Failed restart retained the rejected engine configuration

- **What it is** — restart installed the new environment, then attempted rollback without restoring the old one (`src/status-server/preset-runtime-coordinator.ts:355`, `:382`).
- **Purpose** — apply a saved CPU count and recover if startup fails.
- **Why it's an issue** — this was a partial fix rather than complete lifecycle handling: a rejected count was retried during rollback, so a previously working engine could remain down.
- **The fix** — engine replacement returns a detached previous configuration; the coordinator restores that snapshot before reloading the previous preset. The HTTP regression rejects 8 threads and verifies launch attempts of 4, 8, then 4.
- **Context** — original rollback reused the newly mutated environment:

  ```ts
  runtime.setEnvironment(expected.Server.Engines.Exl3.Environment);
  // catch: no engine configuration restoration
  await runtime.ensurePresetReady(previous);
  ```

## 3. Restart combined new environment with stale engine settings

- **What it is** — `setEnvironment` changed one member of a boot-time configuration object while the interpreter, entrypoint, model adapter, and authenticated client retained their original settings (`src/status-server/managed-tabby.ts:104`).
- **Purpose** — make CPU changes take effect without restarting SiftKit itself.
- **Why it's an issue** — the environment-only patch left restart with a mixed configuration and mutated a caller-owned object. This violates complete replacement and explicit state ownership.
- **The fix** — replace the complete configuration only while stopped, clone input/output snapshots, and rebuild the adapter and client together. Remove the old setter and unused client constructor parameter. Tests verify a changed entrypoint/model root, snapshot isolation, and refusal to reconfigure a running process.
- **Context** — original partial mutation:

  ```ts
  setEnvironment(environment: Exl3EngineConfig['Environment']): void {
    this.engine.Environment = { ...environment };
  }
  ```

## 4. Automatic mode inherited hidden CPU overrides

- **What it is** — clearing the field removed the saved value but forwarded the parent process's CPU environment variables (`src/status-server/managed-tabby.ts:33`, `:295`).
- **Purpose** — restore backend defaults when the field is blank.
- **Why it's an issue** — the UI could show automatic selection while a hidden parent value still forced a count. Exact uppercase deletion also missed mixed-case names on Windows.
- **The fix** — filter both CPU override names case-insensitively from parent and configured environment maps, then add only the selected canonical values. Regressions cover uppercase and mixed-case inherited names.
- **Context** — original launch preserved parent CPU values:

  ```ts
  environment: { ...process.env, ...launch.environment },
  ```

## 5. Tabby's model setting could override the selected count

- **What it is** — the field supplied only EXL3's fallback environment variable (`src/status-server/managed-tabby.ts:401`). The installed Tabby backend gives its `cpu_moe_threads` model setting precedence over that fallback.
- **Purpose** — select the worker count used by managed Tabby/EXL3 inference.
- **Why it's an issue** — testing only that one variable reached a fake launcher did not establish that the real backend would honor it.
- **The fix** — derive both `EXL3_MOE_CPU_THREADS` and `TABBY_MODEL_CPU_MOE_THREADS` from the selected value in the same environment used for identity and launch. The launch regression verifies both.
- **Context** — the original persistence action set only the fallback:

  ```ts
  environment.EXL3_MOE_CPU_THREADS = action.value;
  ```

## 6. The numeric field had no accessible name

- **What it is** — the visible label was a sibling without a matching `for`/`id`; the new input had no `aria-label` (`dashboard/src/tabs/SettingsTab.tsx:128`).
- **Purpose** — expose the count on the General page beside Version.
- **Why it's an issue** — assistive technology could not identify the control by its visible name. A DOM query by role and name reproduced the failure.
- **The fix** — name the input explicitly. The interaction test locates it as the “Tabby/EXL3 CPU threads” spinbutton.
- **Context** — the original input only provided numeric presentation:

  ```tsx
  <input type="number" min="1" step="1" placeholder="Automatic" />
  ```

## 7. The UI test never exercised editing or saving

- **What it is** — the new test inspected static HTML, so a broken change handler or controller action could still pass (`dashboard/tests/settings-cpu-threads.test.tsx:19`).
- **Purpose** — verify the user's settings workflow.
- **Why it's an issue** — it tested presentation rather than the behavior the feature introduced. Backend-only tests could not catch missing UI wiring.
- **The fix** — replace the markup-only test with a DOM/controller interaction test covering edit, dirty state, save/reload, rejected saves, and clearing. Retain separate real HTTP persistence/restart/rollback tests; dashboard test isolation prohibits child-process fixtures and its stricter compiler cannot import the entire backend test harness.
- **Context** — the original checks could pass with an inert control:

  ```ts
  assert.match(automatic, /placeholder="Automatic"/u);
  assert.match(configured, /type="number"[^>]*min="1"[^>]*step="1"[^>]*value="8"/u);
  ```

## Validation and limits

Failing regressions were observed before the runtime/UI fixes. Final results: 4,302 backend tests passed, four skipped; 661 dashboard tests passed; `npm run typecheck` passed, including `npm run lint`. Independent review found no remaining concrete production issues. Live EXL3 hardware inference is outside this validation; the tests use the real HTTP configuration/restart paths with a controlled engine launcher.

Windows System log event 2004 from `Microsoft-Windows-Resource-Exhaustion-Detector` confirmed the virtual-memory exhaustion reported by the user. No test processes remained after the interruption; Windows subsequently reported about 110 GiB of free physical memory. Final validation used the reduced concurrency and heap limits described above.
