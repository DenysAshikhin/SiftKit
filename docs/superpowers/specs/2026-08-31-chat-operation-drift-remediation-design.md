# Chat Operation Drift Remediation Design

## Goal

Remove the session-introduced ownership, lifecycle, persistence, duplication, and type-boundary drift from the chat repo-agent approval and Stop implementation.

## Scope

This design covers all ten ranked reflection findings plus the persisted approval actor-attribution issue:

1. Enforce Stop ownership on the server.
2. Preserve live state when a Stop request fails.
3. Persist repo-agent transcript rows atomically.
4. Give foreign/recovered busy state an authoritative recovery lifecycle.
5. Never expose approval timeouts as actionable approvals.
6. Replace generic-JSON active-run IO with a shared schema.
7. Replace the handwritten dashboard decision contract with a shared schema.
8. Derive the server repo-agent request type from runtime schemas.
9. Remove the core-chat dependency on the route module.
10. Consolidate duplicate aborted-stream terminal handling.
11. Stop labelling persisted multi-client decisions as “You”.

## Operation ownership

Every dashboard stream request carries a client-generated UUID `operationId`. The browser generates it before starting the request, records it in the selected session's local activity state, and includes it in message, plan, repo-search, and repo-agent request payloads.

The session-operation registry stores `operationId` on the lease. `POST /dashboard/chat/sessions/:id/stop` requires `{ operationId }` and aborts only when both session ID and operation ID match the active lease. A missing active operation returns 409; a mismatched operation ID returns 409 without revealing the active ID.

A client-generated ID is required because a server-generated response token would not reach the browser until after a queued request receives response headers, which is too late for queued Stop.

## Authoritative activity lifecycle

Add `GET /dashboard/chat/sessions/:id/operation`. It returns a shared, validated response containing the operation kind and start time, or 404 when the lease is absent. It never returns the private `operationId`.

Dashboard runtime activity becomes a discriminated union:

- `idle`
- `local`, containing `operationKind` and `operationId`
- `remote`, containing `operationKind`

Local streams transition to `local` before fetching and return to `idle` on `done` or terminal stream failure. A valid 409 transitions to `remote`. Reload recovery queries the session, active repo-agent state, and operation status together. A short polling effect runs only while activity is `remote`; when the lease disappears, it refreshes the session and returns activity to `idle`.

A recovered approval is remote-owned because the reloaded browser has no originating operation ID. Approval actions remain available while the composer remains locked. After a recovered decision, polling continues until the server lease disappears and then refreshes the persisted result.

Stop transport errors use a separate nonterminal control-error transition. They do not clear activity, live messages, submitted input, or approval state.

## Shared contracts and validation

Move these public schemas into `@siftkit/contracts` and derive all public types with `z.infer`:

- repo-agent decision request
- chat repo-agent stream request fields used by the dashboard
- active chat repo-agent response, restricted to `running` and `approval_required`
- chat operation status response
- Stop request and response

The server's active repo-agent endpoint returns 404 for terminal states, including `approval_timeout`; therefore the dashboard cannot render an expired approval as actionable.

Test-only mock fields remain server-local. Their extras schema is composed from existing runtime schemas, and the server request type is derived from that schema plus the already-validated base request type.

## Server module boundaries

Move `ChatRepoAgentDecisionRecord` and `ChatRepoAgentRunBinding` from the HTTP route into a neutral status-server module. Store the canonical decision object rather than copying its discriminant and optional reason into separate fields. Core transcript persistence and the route both depend on this neutral module; core chat never imports from `routes/`.

## Atomic transcript persistence

Split the current chat turn helper into:

- a pure builder that returns the updated session without writing;
- the existing public append helper, which calls the builder and saves once.

Repo-agent persistence calls the pure builder, inserts approval rows before the final assistant answer, and calls `saveChatSession` exactly once. Missing-session and malformed-result states continue to fail loudly. No compatibility or dual persistence path remains.

## Aborted-stream handling

Keep the shared partial-answer capture and stopped-turn builder. Add one helper that:

1. checks the request AbortSignal;
2. persists the stopped turn;
3. emits the normal `done` response;
4. reports whether it consumed the caught error.

Message, plan, and repo-search catch blocks call this helper and retain only their endpoint-specific non-abort error formatting.

## Approval attribution

Persisted approval rows render the actor as `User`, not `You`, because the durable message does not contain authenticated client identity. No synthetic ownership claim is made.

## Testing

Use TDD for each behavioral change. Required coverage:

- a second client cannot stop another operation with a different operation ID;
- the originating client can stop while queued and while generating;
- a failed Stop request preserves local live and approval state;
- a 409 remote activity polls until the lease disappears and then unlocks;
- reload at a parked approval restores a remote-owned card and locked composer;
- a recovered approval decision remains busy until terminal persistence is visible;
- `approval_timeout` is never returned as active/actionable;
- shared public schemas accept valid payloads and reject malformed payloads;
- repo-agent turn persistence performs one authoritative save containing user, approvals, and result;
- all three ordinary stream endpoints retain identical stopped-turn semantics through the shared helper;
- persisted approval rows use neutral actor attribution.

Run focused server/dashboard/contract suites after each TDD slice, followed by `npm run typecheck`, `npm run lint`, and the complete test suite.

## Constraints

- Client disconnects still must not abort runs.
- The model-lock wait remains non-abortable; an already-requested Stop takes effect when the queued operation reaches engine execution.
- No worktree, compatibility shim, fallback path, new dependency, or commit.
- All IO is runtime-validated and all public types are inferred from schemas.
