# Implementation plan: owner identity consolidation

## Status (2026-09-03)

| Task | State |
|---|---|
| A — "This is me" on a person node | done: service, route, dashboard control, `assistant-owner-identity` (5) + `assistant-claim-owner` (5) green |
| B — a near-miss name is a question | done: promoter hold, `resolveIdentity`, route, validation-card answers, `assistant-owner-alias-question` (7) + 2 settings tests green |

Follow-ups from the 2026-09-03 drift review (structured holds, owner-direction guard, pronoun
aliases, explicit "no" answers, alias reconciliation) are tracked in
`docs/plan-session-drift-fixes.md`.

Prerequisite defect fixed on the way: the `owner_identity_collapse` guard keyed off `person:self`
while the runtime writes `person:owner`, so it had never fired in production.

Full runner 3621 tests / 0 failures. Dashboard runner 378 / 1 failure, which is the pre-existing
`chat-live-messages` repo-agent case — it fails identically at baseline and touches nothing here.

OCR reads the owner's name off window title bars several ways, and a chat transcript paraphrases
it differently again. Each spelling becomes its own `person` node, and every fact on it is
invisible to the memory tiers — `ProjectionCompiler.collectViews`
(`src/assistant/projections/projection-compiler.ts:200-211`) reads assertions by subject = the
owner node only. Live evidence: seven duplicate nodes holding 97 facts, consolidated by hand on
2026-09-03.

Two changes stop it recurring. Both route through `NodeMergeService`, so every consolidation is
audited and reversible; neither ever decides an identity on its own.

Prerequisite, already done: `MergeRequest.actorType` (`src/assistant/graph/merge-service.ts`)
distinguishes a merge the owner asked for from one the assistant proposed. The
`owner_identity_collapse` guard still refuses the latter.

---

## Task A — "This is me" on a person node

**Gap.** The dashboard can view a `person` node but cannot say it is the owner. Consolidation is
only possible by hand against the database.

**Change.**
- `AssistantService.claimNodeAsOwner(nodeId, reason)`: merges the node into the owner person node
  with `actorType: 'user'`, under `runMaintenance` so it cannot race a drain. Rejects a node that
  is not `person`, is already the owner, or is not active. Returns the merge id so the caller can
  reverse it.
- Contract: `AssistantClaimOwnerRequestSchema` (`{ reason }`) and a response carrying
  `mergeId`, `movedAssertionCount`, `movedAliases`.
- Route: `POST /assistant/graph/nodes/:id/claim-owner`, alongside the existing assertion
  mutation routes in `src/status-server/routes/assistant.ts`.
- Dashboard: on the node detail view, a "This is me" control shown only for an active `person`
  node that is not already the owner. It states what will happen — facts move, the node is marked
  merged, the merge is reversible — before it fires.

**Tests.**
- `tests/assistant-owner-identity.test.ts`: `claiming a person node moves its facts onto the
  owner`; `claiming the owner node itself is refused`; `claiming a non-person node is refused`;
  `the claim is reversible through the merge log`.
- Route test: the endpoint requires the bearer and 404s while the assistant is disabled.

---

## Task B — a near-miss name is a question, never a new person

**Gap.** `CandidatePromoter.resolveNode` creates a node for any unmatched `person` name. A name
one or two characters off an owner alias — `denyz`, `dennys` — is almost always the owner, but
`EntityResolver`'s contract (`src/assistant/graph/entity-resolver.ts:46-49`) forbids merging on
name similarity, correctly: `Denis` may be a real colleague.

**Change.** Make the near miss a *question* instead of either a merge or a new node.
- A `person` subject or object whose normalized name is within a small edit distance of an owner
  alias, and long enough that the distance means something, parks the candidate as
  `needs_confirmation` with reason `possible_owner_alias`. No node is created.
- `ValidationQueueService` gains `resolveIdentity(candidateId, isOwner)`:
  - `true` — adds the name to the owner node as a `user_supplied` alias, then re-promotes the
    candidate, which now resolves to the owner by alias. Every later occurrence resolves silently.
  - `false` — records the decision so the same name is not asked again, then promotes normally,
    creating the separate person node.
- Route: `POST /assistant/validation/:id/resolve-identity`.
- Dashboard: the validation card renders the two answers when the reason is `possible_owner_alias`.

**Do not** lower the edit-distance threshold to catch more. A false positive here writes a
permanent owner alias, and the point of the question is that the owner decides.

**Tests.**
- `a near-miss person name parks the candidate instead of creating a node`.
- `an exact owner alias still resolves silently` — the question must not fire for a known name.
- `an unrelated person name still creates its own node` — the threshold does not over-reach.
- `answering yes adds the alias and promotes onto the owner`.
- `answering no promotes onto a separate node and is not asked again`.

---

## Verification

`npm run typecheck`, `npm run lint`, the named suites, then the full runner. State which tests
were added and why each failed before the change.
