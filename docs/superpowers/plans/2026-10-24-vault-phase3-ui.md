# Vault Phase 3 — Dashboard vault UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Memory Inspector (`AssistantTab`) with `VaultTab`, a React port of `docs/mockups/vault/index.html` backed by the Phase 2 `/assistant/vault/*` API.

**Architecture:** Pure logic lives in `dashboard/src/lib/vault-*.ts` and is unit-tested with vitest: the note renderer's block and inline model (built on the shared `@siftkit/contracts` parser), the force simulation and `fitView`, `lineDiff`, tab state, and body edits. React components in `dashboard/src/components/vault/` stay thin and are tested with `renderToStaticMarkup`. `useVaultController` owns all state and fetching, using the existing bearer-token pattern. CSS is ported into `dashboard/src/styles/vault.css`. Every class carries a `v-` prefix so nothing collides with the dashboard's global `.view`, `.chip`, `.search`, `.toast`, `.dot`, `.row` or `.ctx`.

**Tech Stack:** React 19, TypeScript (native Node 26), zod contracts, vitest (node environment, SSR strings), Canvas 2D.

> **Status: implemented.** Deviations from the plan as written:
> - **Component layout:**
>   - There is no separate `VaultLayout`; `VaultTab` composes the layout, because a forwarding wrapper would add nothing.
>   - The panels share `VaultPanels.tsx`.
>   - The palette, hover card and status bar share `VaultChrome.tsx`.
>   - `GraphView.tsx` also holds `LocalGraph`.
> - **Shared constants:**
>   - The shared tag pattern is now a lookbehind with the tag in group 1.
>   - `VAULT_LOCAL_GRAPH_CAP` moved to contracts, so the server cap and the client's "capped" label share one value.
> - **Diff ordering:** a replaced line diffs as delete then add (the mockup did add first).
> - **Tests:** `tests/assistant-dashboard-e2e.test.ts`, which exercised the removed inspector client, became `tests/vault-dashboard-e2e.test.ts`. It drives `vault-api.ts` against a live status server.
> - **Unused route:** `deleteVaultNote` is not in the client, because the UI has no delete action.

---

## Decisions

- **Scope (spec §4.4):**
  - In: the file tree, note view (renderer), editor (`[[` autocomplete, Ctrl+S), global graph, local graph, graph preview, Links/Outline/History/Vault panels, diff with restore, review, search, quick switcher, status bar, hover card, toast, and shortcuts (Ctrl+O/K, Ctrl+Shift+F, Ctrl+E, Ctrl+G).
- **Dropped from the mockup:** each item depends on an API that later phases add.
  - The Tags pane. There is no tag listing endpoint, and the spec component list has no tags panel; tags stay clickable and become a `tag:#x` search.
  - Writes-by-actor, migration stats, the note-writer queue, and pending captures.
  - Embedded PNGs. The attachments route is Phase 4, so embeds render as captioned placeholders that show the attachment path.
- **Note index:** one unfiltered `GET /vault/graph` gives every note's id, title, folder, topFolder and degree. It feeds:
  - the quick switcher's fuzzy match;
  - `[[` autocomplete;
  - pill colours;
  - the global graph, which filters on the client by hidden folders and minimum degree, so dragging the slider never refetches.
  - The index is refetched after every write.
- **Link resolution in the renderer:**
  - A link is unresolved iff `vaultKey(target)` is in `detail.outgoing.unresolved`.
  - A pill's colour comes from the index entry with the same key; an alias target gets the accent colour.
  - Clicking a link calls `GET /vault/resolve`. An unresolved target creates the note and opens it in edit mode, as in the mockup.
- **Shared dialect:**
  - `vaultKey` moves from `src/vault/note-rows.ts` to `packages/contracts/src/vault-markdown.ts`; the server imports it from contracts.
  - `parseFactRow`, `VAULT_LINK_PATTERN` and `VAULT_TAG_PATTERN` are exported so the dashboard renderer reuses one definition of the dialect.
- **Writes:**
  - Edit, task toggle, triage and "link it" all `PUT` the whole body with `expectedRevision`. A 409 reloads the note and toasts "changed elsewhere".
  - Rename and restore use their own endpoints.
  - Triage reuses `confirmUnverified` and `dropLine` from contracts.
- **Removed:**
  - `AssistantTab`, `AssistantMemoryDetail`, `AssistantQuestionCard`, `useAssistantController`;
  - the memory, question and policy functions in `dashboard/src/assistant-api.ts`;
  - `assistant.css` inspector rules;
  - the tests `assistant-tab`, `assistant-claim-owner`, `assistant-evidence-reveal`.
  - Settings → Assistant (maintenance, desktop and pending captures) is untouched. Server question routes stay until Phase 5/7.

## File map

| File | Responsibility |
|---|---|
| `packages/contracts/src/vault-markdown.ts` (modify) | export `vaultKey`, `parseFactRow`, `VAULT_LINK_PATTERN`, `VAULT_TAG_PATTERN` |
| `src/vault/note-rows.ts`, `src/vault/note-store.ts` (modify) | import `vaultKey` from contracts |
| `dashboard/src/vault-api.ts` | typed fetch client for all 17 vault routes |
| `dashboard/src/lib/vault-inline.ts` | inline tokens: code, bold, italic, dim, wikilink, tag |
| `dashboard/src/lib/vault-blocks.ts` | body → blocks: lead, facts, heading, list (task / unverified / row), callout, embeds, fence, paragraph, long-note cut |
| `dashboard/src/lib/vault-edits.ts` | `toggleTask`, `linkFirstMention`, `linkQueryAt`, `insertLink`, `fuzzyMatch`, `rankTitles`, `contextGroups`, `outlineOf` |
| `dashboard/src/lib/vault-diff.ts` | `lineDiff`, `diffRows` (3 context lines, gap rows) |
| `dashboard/src/lib/vault-force.ts` | `ForceSimulation`, `fitView`, `pickNode`, `folderColors`, `buildSimGraph`, `filterGraph` |
| `dashboard/src/lib/vault-tabs.ts` | tab state: `openNoteTab`, `openSpecialTab`, `closeTab`, `setTabMode`, `tabLabel` |
| `dashboard/src/lib/vault-time.ts` | `ago`, `fmtTime` |
| `dashboard/src/hooks/useVaultController.ts` | state, fetching, actions, keyboard shortcuts |
| `dashboard/src/components/vault/*.tsx` | `VaultLayout`, `FileTree`, `SearchPanel`, `NoteView`, `NoteMarkdown`, `NoteEditor`, `GraphCanvas`, `GraphView`, `LocalGraph`, `GraphPreview`, `LinksPanel`, `OutlinePanel`, `HistoryPanel`, `DiffView`, `ReviewView`, `VaultStatsPanel`, `QuickSwitcher`, `HoverCard`, `StatusBar` |
| `dashboard/src/tabs/VaultTab.tsx` | composes the layout from controller props |
| `dashboard/src/styles/vault.css` | ported mockup CSS, `v-` prefixed |
| `dashboard/src/App.tsx`, `components/Rail.tsx`, `styles.css` (modify) | swap the tab, title, CSS import |

## Tasks

### Task 1: Shared dialect exports
- [ ] Test (`tests/vault-markdown.test.ts`):
  - `vaultKey('  Foo Bar ')` → `'foo bar'`;
  - `parseFactRow('**Uses** [[A]] · b')` → `{label: 'Uses', rest: '[[A]] · b'}`, and `parseFactRow('plain')` → `null`;
  - `[...'x [[A|b]] #t'.matchAll(VAULT_LINK_PATTERN)]` has 1 match, and the tag pattern matches `#t`.
- [ ] Rename the private `matchFactRow` to an exported `parseFactRow`. Export the two patterns and `vaultKey`. Delete `vaultKey` from `note-rows.ts` and import it from contracts in `note-store.ts`.
- [ ] Run `node .\src\test-runner\run-tests.ts vault-` (all green), then `npm run typecheck`.

### Task 2: `vault-api.ts`
- [ ] Test (`dashboard/tests/vault-api.test.ts`), stubbing `globalThis.fetch`:
  - `getVaultNote(token, 'a b')` requests `/assistant/vault/notes/a%20b` with a Bearer header and parses `VaultNoteDetailSchema`;
  - `updateVaultNote` sends `PUT` with a JSON body;
  - a 409 body `{error: {code: 'conflict', message, currentRevision: 3}}` throws `VaultRequestError` with `status === 409` and `code === 'conflict'`;
  - `getVaultGraph` hits `/assistant/vault/graph`.
- [ ] Implement `request(path, token, schema, init)`, mirroring `assistant-api.ts`, but throw `VaultRequestError(status, code, message)` parsed with `AssistantErrorResponseSchema`. Add one function per route: `getVaultTree(token, stubs)`, `listVaultNotes(token, folder, stubs, limit)`, `getVaultNote`, `resolveVaultTitle`, `createVaultNote`, `updateVaultNote`, `renameVaultNote`, `deleteVaultNote`, `listVaultRevisions`, `getVaultRevision`, `restoreVaultRevision`, `searchVault`, `getVaultGraph`, `getVaultLocalGraph`, `getVaultReview`, `getVaultStats`, `exportVault` (returns a Blob).

### Task 3: Inline and block model
- [ ] Tests (`dashboard/tests/vault-blocks.test.ts`):
  - **Inline:**
    - `` `a` `` → code;
    - `**b**` → bold;
    - `*i*` → italic;
    - `_d_` → dim;
    - `[[T|L]]` → link `{target: 'T', label: 'L'}`;
    - `#tag` → tag `'tag'`;
    - the plain text between tokens is preserved.
  - **Blocks:**
    - the first plain line → `paragraph{lead: true}`, later ones → `lead: false`;
    - consecutive `**L** v` lines → one `facts` block with rows `{label, values}`, values from `splitValues`;
    - `## H` → `heading{level: 2, line}`, and `#` is promoted to level 2;
    - `- [ ] x` → a list item `{kind: 'task', done: false, line}`;
    - `> [!unverified]- 2 …` with `> - **L** v #unverified` lines → `callout{kind: 'unverified', fold: '-', title, items}`, where each item is `{kind: 'unverified', label, line}`;
    - a callout with a plain value line → `callout.pills`;
    - consecutive `![[a.png]]` lines → `embeds{targets: [a, b]}`;
    - a fenced block → `fence`;
    - a `> quote` without a `[!kind]` header → `quote`;
    - `limit: 3` on a 10-line body → the last block is `more{remaining: 7}`;
    - `full: true` disables the cut.
- [ ] Implement `inlineTokens(text)` with one alternation regex. The link and tag sources come from the contracts patterns. Implement `noteBlocks(body, {limit, full})`, which walks lines with the same state machine as the mockup's `renderMarkdown`. It uses `parseFactRow` for rows and the set of `parseNoteBody(body).unverified` lines for unverified items. `MAX_RENDER_LINES = 400`.

### Task 4: Body edits, ranking, outline
- [ ] Tests (`dashboard/tests/vault-edits.test.ts`):
  - `toggleTask(body, line)` flips `[ ]` to `[x]` and back, and throws on a non-task line;
  - `linkFirstMention('I use siftkit daily', 'SiftKit')` → `'I use [[SiftKit]] daily'`, an existing `[[SiftKit]]` is not double-wrapped, and no match returns `null`;
  - `linkQueryAt('see [[Fo', 8)` → `'Fo'`, and `null` after a closed `]]`;
  - `insertLink(value, caret, 'Foo')` → `{value: 'see [[Foo]]', caret: 11}`, swallowing a trailing `]]`;
  - `fuzzyMatch('sk', 'siftkit')` is true and `fuzzyMatch('ks', 'sk')` is false;
  - `rankTitles(entries, 'si', 12)` puts prefix matches first, then sorts by degree descending;
  - `contextGroups(backlinks)` groups notes by label, an empty label becomes `'Mentioned in'`, and groups are sorted by size;
  - `outlineOf(body)` → headings `{line, text, level, items}`.

### Task 5: Diff
- [ ] Tests (`dashboard/tests/vault-diff.test.ts`):
  - `lineDiff(['a','b','c'], ['a','x','c'])` → `ctx a, del b, add x, ctx c`;
  - identical inputs → all `ctx`;
  - empty before → all `add`;
  - when `A×B > 4_000_000`, it falls back to delete-all and add-all;
  - `diffRows(ops, {collapse: true})` keeps 3 context lines around each change and inserts a single `gap` row for each elided run;
  - `{collapse: false}` keeps every line.

### Task 6: Force simulation and view fitting
- [ ] Tests (`dashboard/tests/vault-force.test.ts`):
  - a hub with 300 leaves plus a chain, run for 300 ticks:
    - every coordinate is finite;
    - `alpha` decays below 0.02;
    - the hub stays within 200 units of the origin;
  - `fitView` on nodes spanning x −100..100 and y −50..50 in an 800×600 rect → `k = min(800/280, 600/180)` clamped to 2.2, centred;
  - `reserveRight` shifts `x` by −reserve/2;
  - an empty node list returns the input view unchanged;
  - `pickNode` returns the nearest node within the radius, else `null`;
  - `folderColors(['b','a'])` assigns colours in sorted order;
  - `filterGraph(graph, hidden, minDegree)` drops hidden top folders and low-degree nodes, together with their edges;
  - `buildSimGraph` computes the in-subgraph degree and the radius `2.5 + sqrt(deg) * 1.1`.
- [ ] Implement `ForceSimulation` as a class, since it owns mutable node state and `tick()`. Constants are named after the mockup: `CELL = 110`, `REPULSION = 60`, `MIN_DIST2 = 25`, `GRAVITY = 0.008`, `SPRING_LENGTH = 40`, `MAX_VELOCITY = 30`, `DAMPING = 0.6`, `ALPHA_DECAY = 0.985`.

### Task 7: Tabs and time
- [ ] Tests (`dashboard/tests/vault-tabs.test.ts`):
  - opening a note when the active tab is a read-mode note replaces it;
  - an edit-mode active tab, or `newTab`, pushes a new tab;
  - a note that is already open activates its existing tab;
  - `openSpecialTab('graph')` reuses its tab;
  - a diff tab is keyed by note and revision;
  - `closeTab` clamps `active`;
  - `tabLabel` handles the graph, review, diff and edit-mode prefixes;
  - `ago` handles minute, hour and day buckets relative to an injected `now`.

### Task 8: Components and CSS
- [ ] Tests (`dashboard/tests/vault-components.test.tsx`), using `renderToStaticMarkup`:
  - **`NoteMarkdown`:**
    - renders `p.v-lead`, `.v-facts .v-frow` with `.v-pill` and `.v-pill.v-unresolved`, and `.v-pill.v-txt`;
    - renders `details.v-callout.v-co-unverified` with keep and drop buttons;
    - renders a task checkbox with `checked` when done;
    - renders `.v-thumbs` for 2 embeds and `.v-tag` for tags;
    - renders `.v-long-note` past the limit.
  - **`NoteView`:** breadcrumbs, the title, the Read/Edit segment, "also known as" (5 shown, then "and N more"), and the properties summary with revision count and kind.
  - **`HistoryPanel`:** revisions newest first, with the actor class `v-actor-you` / `v-actor-migration` / `v-actor-writer` / `v-actor-tidy` / `v-actor-intake`.
  - **`DiffView`:** `+N −M`, the restore button only for a non-current revision, and `.v-gap` rows.
  - **`ReviewView`:** the count stats and one row per item with ✓ and ✕.
  - **`LinksPanel`:** linked-mention counts, outgoing chips, and unlinked mentions with "link it".
  - **`StatusBar`:** note and unverified counts, plus the Export button.
  - **`FileTree`:** the Starred section, folders with icon and count, and the stub toggle text.
- [ ] Implement the components as presentational ones taking explicit props. Interactive callbacks are props, as React requires. `GraphCanvas` owns the canvas, `requestAnimationFrame`, drag/pan/zoom, hover, click, double-click and `ResizeObserver`. Port `vault.css` from the mockup with the `v-` prefix.

### Task 9: Controller, `VaultTab`, App swap, removal
- [ ] Test (`dashboard/tests/vault-tab.test.tsx`): `VaultTab` with a fixture props object renders the ribbon, the tree, the tab bar with "◎ Graph view" active, the right-hand tabs, and the status bar.
- [ ] Implement `useVaultController()`:
  - **Initial load:** the token comes from `bootstrapAssistantToken`, then the index (graph), tree, stats and starred notes. Starred notes are:
    - the owner, from the first `tag:#me` search hit;
    - `SiftKit`, via resolve;
    - the latest note in `Daily` (`listVaultNotes(…, 'Daily', false, 1)`).
  - **Startup tabs:** graph (active), owner, SiftKit, then the latest daily note.
  - **Caches:** note details, folder note lists and revisions.
  - **Actions:** open, close, mode, save, rename, toggle task, triage, link it, restore, create, export, search (debounced 150 ms), expand, local graph depth, graph options.
  - **Shortcuts:** a window `keydown` listener.
  - **After a write:** refresh the note, the index, the tree and the stats.
- [ ] `App.tsx`: replace `useAssistantController`/`AssistantTab` with `useVaultController`/`VaultTab`. Set `SECTION_TITLES.assistant` to `'Memory vault'`, and the Rail title to `'Memory vault'`.
- [ ] Delete the obsolete inspector files, API functions, CSS and tests listed in Decisions. Run `grep` to confirm no references remain.
- [ ] Run `npm run test:dashboard`, `npm run typecheck` (includes lint) and `npm test`.
