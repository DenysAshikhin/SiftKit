# Memory UI mockups

Redesigns of the Assistant tab's memory surface. Open any `.html` file directly in a
browser — no server, no build step, no network.

**A and B are the chosen direction and are now wired together** as two views of one app,
with an Overview/Explorer switcher in the header:

| File | Role |
|---|---|
| [variant-a-dashboard.html](variant-a-dashboard.html) | **Overview — the landing page.** Opens with the generated "what I learned" digest, then *Needs your review*, capacity gauges, composition charts and pipeline health. Answers "what does it know, what needs me, and is it healthy?" |
| [variant-b-explorer.html](variant-b-explorer.html) | **Explorer — the in-depth technical view.** Facet rail → Entities / Review / History → belief inspector with provenance and per-belief actions. Answers "what exactly does it believe about X, why, and what changed?" |

## The Settings fold

`Settings → Assistant` used to carry three tabs: Configuration, **Pending validation**, **Memory history**. The latter two are folded into these pages, leaving Settings as configuration only:

| Was in Settings | Now lives in | Why |
|---|---|---|
| Pending validation → identity holds | Overview, *Needs your review* | 37 candidates are held on "is *deny* you?" — the same identity fragmentation the digest leads with. Triage belongs on the landing page. |
| Pending validation → ordinary candidates | Explorer, `Review` mode | 1,293 items is a working queue, not a dashboard widget. |
| Pending validation → pending captures | Overview, *Pipeline health* | It is pipeline state, not a decision. |
| Memory history | Explorer, `History` mode | Provenance sits next to the beliefs it explains. |

Every endpoint these need already exists (`/assistant/validation`, `/assistant/history`, `/assistant/captures/pending`, …), so the fold is frontend-only.

[variant-c-workbench.html](variant-c-workbench.html) is kept for reference only — the dense
console direction was not chosen. It still builds and still has the chat dock, but it is not
part of the A↔B flow.

All variants share the memory-assistant chat dock (bottom right) and render the **same real data**.

## The landing digest

Variant A opens with a generated greeting — *"Good morning, Denys. Since yesterday I picked up
24 new entities and 56 new beliefs…"* — written from the actual deltas in the snapshot.

Behaviour, all demoable in the mockup:

- **Generated on demand.** Nothing is precomputed at page build. On open it shows a shimmer
  skeleton, runs a freshness check, then streams the digest in word by word with a caret.
- **Cache reuse.** If nothing interesting arrived since the last digest, it serves the cached
  one instead of spending a generation. The badge switches to `reused from cache · 18h old`
  and paints instantly. Click **Demo: cached** to see that path; **Regenerate** forces a fresh run.
- **Legible freshness rule.** *Why this?* expands to the actual trigger: 24 new entities and
  56 new beliefs since the last digest at 2026-09-09 18:04Z. Below threshold → reuse.
- **Bounded input.** The digest is built from the Tier 1 profile plus what changed since the
  last run — never the full 1,408-belief graph.
- **It ends in an action.** The digest surfaces the identity-fragmentation problem and hands off
  to the chat dock ("Merge my 4 identities") or into Explorer ("Explore what changed").

The greeting adapts to time of day. The text itself is scripted for the mockup — two variants,
fresh and cached — not model output.

## The data is real

Every number comes from `.siftkit/runtime.sqlite`, snapshotted to
[snapshot.json](snapshot.json) at `2026-09-10T12:40:33Z` and inlined into each HTML file
(`fetch` of local JSON is blocked over `file://`, so inlining is what makes these standalone).

Headline figures the mockups are built around:

- **Tier 3 at 439/500 documents (87.8%)** — 61 slots from the archive threshold.
- Tier 1 at 1/1, Tier 2 at 2/25. 442 documents, 64,969 projected tokens total.
- 1,109 entities, 1,408 active beliefs, **0 pinned**.
- **88.6% of beliefs carry confidence 0**, and only 2 of 1,408 came from an explicit
  statement by you — the rest are passive observation.
- Only **4 documents have ever been retrieved** (3 of them in Tier 3). The other 438 occupy
  capacity unread.
- 4 likely duplicate entity pairs (`SiftKit`×2, `The Last Spark`/`TheLastSpark`,
  `Visual Studio Code`/`VS Code`, `Unknown`/`Unknown User`).
- **Your own identity is split four ways** — `the user` (712 beliefs), `User denys` (21),
  `user 'denys'` and `Browser User` are all the same person, so your history is fragmented
  across four entities. This is what the landing digest leads with.
- **1,333 candidate beliefs await review**, of which **37 are blocked on "is this you?"** — the
  held names are OCR misreads of *denys*: `deny` ×13, `demyz` ×8, `denvys` ×6, `deryn` ×5,
  `demyxs` ×5. Nothing is written until they are answered.
- **7,340 recorded memory changes, of which you made 7.** The rest are `system` (3,872) and
  `assistant_proposal` (3,461).

Those last four points are design problems the current UI cannot express at all, which is
why each variant surfaces them prominently.

## The chat dock

A collapsible assistant scoped to **memory tools only**, present in all three variants.
Click "Memory assistant", or the command bar in Variant C.

It is scripted, not live — keyword-routed canned replies. Five intents work:

- "merge the duplicate SiftKit entries" → merge preview
- "I don't use llama.cpp any more" → retire beliefs
- "forget everything about League of Legends" → irreversible-forget preview
- "free up Tier 3 space" → archive lowest-utility documents
- "why do you think I use CUDA?" → explanation + pin/correct

Anything else hits a capability fallback.

Two deliberate UX commitments:

1. **Every mutation renders a preview card with an explicit Apply/Discard**, mirroring the
   real `cleanup/preview` → `previewToken` → `cleanup` contract rather than acting immediately.
2. **Every reply shows its tool trace**, so it is always visible which endpoints were touched.

The tool list on the `memory tools only` chip is the real endpoint surface from
[src/status-server/routes/assistant.ts:85-175](../../../src/status-server/routes/assistant.ts#L85-L175):
`search`, `graph/nodes`, `graph/assertions`, `assertions/:id/{explanation,confirm,correct,pin,demote}`,
`DELETE assertions/:id`, `topics/forget{,-preview}`, `cleanup{,/preview}`, `projections/rebuild`.

One gap worth noting: **entity merge has no HTTP endpoint today.** The `graph_entity_merges`
table and `validation/:id/resolve-identity` exist, but the merge flow the mockups show would
need new surface area. Everything else maps to a route that already ships.

## Regenerating

```bash
node docs/mockups/memory/variant-a.mjs
node docs/mockups/memory/variant-b.mjs
node docs/mockups/memory/variant-c.mjs
```

`build.mjs` holds the shared shell, theme, derived stats, header nav, the chat dock, and the
landing digest; each `variant-*.mjs` owns its own layout and CSS. To refresh against a newer
database state, re-export `snapshot.json` (the query lives in the session that produced it)
and re-run the three.

## Status

Mockups only. No production code was touched, and nothing here is wired to the running
dashboard.

Verified: all inline scripts parse; all five chat intents route correctly; the digest's fresh
path streams 3 paragraphs and lands on `generated just now`, the cached path paints instantly
as `reused from cache`, and the *Why this?* toggle works; A↔B nav marks the right tab active
on each page; rendered figures match `snapshot.json` exactly.

Not verified: real browser rendering. No headless browser is installed in this repo, so the
visual result has been checked only against a DOM stub, not machine-checked visually.
