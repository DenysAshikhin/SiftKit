# Repo-Agent Drift Elimination Design

## Goal

Eliminate the seven confirmed drift findings in the server-owned repo-agent migration without compatibility paths, untyped implementation, split-brain run state, incomplete build cleanup, or an excluded session suite.

## Constraints

- Work in `feature/repo-agent-server-owned-runs` without committing.
- Do not use SiftKit in this session.
- Replace obsolete paths completely; do not add shims or fallbacks.
- All added or migrated code and tests are TypeScript with schema-derived IO types.
- Use TDD for every behavioral change and make the complete applicable suite runnable.

## Architecture

### Authoritative server-owned state

`RepoAgentSession` keeps one validated `RepoAgentRunState` as its public state. When durable transition to a failed state throws, the session advances that same in-memory state to `failed` instead of publishing a separate result overlay. The session manager retains only sessions whose terminal state could not be persisted; normally persisted terminal sessions are removed.

The status server exposes repo-agent status through a route that first checks the session manager and otherwise reconciles the run store. The CLI status command uses that route rather than constructing a separate store reader, so start, decide, and status observe the same server-owned state. A server restart discards volatile state, but the old server PID is then dead and normal store reconciliation terminalizes the durable active record.

Admission-log persistence and run-state persistence are separate operations. Admission failure is logged without replacing an already-terminal run result. Run-state persistence failure creates the retained in-memory terminal state. Only a confirmed missing run maps to HTTP 404; corrupt, invalid, or unreadable state maps to a recorded infrastructure error.

### Shared request contracts

Add a strict `RepoAgentDecisionSchema` discriminated union and derive `RepoAgentDecision` with `z.infer`. `RepoAgentDecideRequestSchema` composes the shared run ID with that union. `RepoAgentSession.submitDecision` accepts the schema-derived decision type, so denial always carries a non-empty reason.

`RepoAgentStartRequestSchema.maxTurns` accepts only positive integers when present. `null` and zero are rejected at the HTTP boundary instead of becoming the engine default.

### Complete compiled-output replacement

Migrate `scripts/build-test.js` and `scripts/sync-dist-runtime.js` to TypeScript and execute them with Node type stripping. A clean build removes the entire root `dist` staging/output tree before compilation. Sync copies compiled `dist/src` entries into the flattened runtime root and removes the staging tree afterward. The hardcoded `command`/`interactive` deletion list is deleted because a clean replacement cannot retain any removed top-level output.

### Session-test isolation

Diagnose the complete `repo-agent-sessions.test.ts` hang by running each test independently and inspecting active handles/timers at the failing boundary. Replace repeated process-wide CWD/database/temp cleanup with one explicit session-test harness. The harness owns setup and teardown, injects paths where possible, and guarantees every parked session is decided, aborted, or timed out before cleanup. The full file must pass as one invocation without name filtering.

## HTTP Behavior

- `GET /repo-agent/status?runId=<uuid>` returns a schema-valid `RepoAgentRunState`.
- Missing runs return 404 only after an explicit existence check.
- Store parse, validation, permission, and lease errors return recorded 500 errors.
- `/repo-agent/decide` uses the same missing-versus-corrupt distinction.
- Volatile failed sessions remain queryable until server exit; their state is never claimed to be durable.

## Testing

Each item starts with a failing regression:

1. A failure-store session reports the same failed state through status and decide after settling.
2. Admission persistence failure does not replace an existing terminal result.
3. A deleted top-level compiled module cannot survive clean build/sync.
4. Corrupt state returns 500 while a missing run returns 404.
5. Deny without a reason fails at the shared decision schema/session boundary.
6. `maxTurns: 0` and `maxTurns: null` return 400.
7. Build scripts typecheck as TypeScript and the complete session test file exits successfully.

Final validation runs the migration-focused suite, the complete session suite, broader applicable endpoint/CLI/build tests, `npm run typecheck`, `npm run lint`, `npm run build`, legacy-artifact checks, and `git diff --check`.
