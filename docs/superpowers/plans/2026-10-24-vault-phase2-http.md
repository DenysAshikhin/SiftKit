# Vault Phase 2 — HTTP API Implementation Plan

> **Status: implemented.** A post-implementation review then changed some details. The code is authoritative: query parameters are parsed with contract schemas through `queryParams` (`booleanParam` was removed); `assistantErrorResponse` maps errors, with programming errors sent as 500; the store derives rename and restore summaries from a `VaultWriteSource`; actors are the closed `VaultActorSchema`; and the resolve route uses `store.resolveId`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Phase 1 vault core over `/assistant/vault/*`, behind the existing assistant auth, rate limiter and `RouteTable`. Every request and response shape is a zod schema in contracts.

**Architecture:**
- `AssistantService` builds the four vault components over its own database, clock and id generator, and exposes them as `memoryQueries` is exposed today.
- Route handlers sit in one new file, `routes/assistant/vault-routes.ts`, built with the existing `assistantRoute` wrapper.
- Vault errors extend the two existing assistant error classes. `AssistantConflictError` gains a wire `code` and recovery `details`, so the shared route error handler maps vault errors with no vault-specific branch.
- Markdown export reuses `TempArchiveBuilder` and `sendArchive`.

**Tech Stack:** TypeScript on Node 26, better-sqlite3, zod 4, `node:test`, and the E2E harness `withAssistantServer`, which boots a real status server.

**Spec:** `docs/superpowers/specs/2026-10-24-memory-vault-design.md` §4.3 and §8.

**Deferred to the phase that builds their module:**
- `GET /assistant/vault/attachments/:path`: Phase 4, with `attachments.ts`. No attachments exist yet.
- `/assistant/vault/migration/*`: Phase 6.
- The note-writer queue in stats: Phase 4/5.
- **Dropped from the spec's route list:** `revisionCount` in the note detail. It always equals `note.revision`, because revisions are only removed together with their note.

---

## Ground rules

Same as Phase 1:
- Run tests with `node .\src\test-runner\run-tests.ts <basename>`.
- Typing rules: no `any`, no casts, no `!`, and every input parsed with zod.
- Comments are 1–2 lines.
- Each task ends with `npm run typecheck`, which includes lint.

## File structure

| File | Responsibility |
|---|---|
| `src/assistant/errors.ts` (modify) | `AssistantConflictError` gains `code` and `details`, set through constructor options. |
| `src/vault/errors.ts` (modify) | Vault errors extend `AssistantNotFoundError` and `AssistantConflictError`. |
| `src/status-server/routes/assistant/helpers.ts` (modify) | `sendError` accepts `details`; adds `booleanParam`. |
| `src/status-server/routes/assistant.ts` (modify) | The error handler uses `error.code` and `error.details`; registers the vault routes. |
| `packages/contracts/src/vault.ts` (modify) | Request and response DTO schemas. |
| `src/vault/note-queries.ts` (modify) | Adds `detail(noteId)`. |
| `src/vault/vault-export.ts` (create) | `exportVault(notes)`: one `.md` file per note, with frontmatter, written to a zip. |
| `src/assistant/assistant-service.ts` (modify) | Composes `vaultNotes`, `vaultQueries`, `vaultSearch` and `vaultGraph`. |
| `src/status-server/routes/assistant/vault-routes.ts` (create) | The vault endpoints. |
| `tests/vault-routes.test.ts` (create) | E2E route tests over a real server. |
| `tests/vault-export.test.ts` (create) | Unit test for the markdown file format. |

---

### Task 1: Wire error codes for conflicts

**Files:**
- Modify: `src/assistant/errors.ts`, `src/vault/errors.ts`, `tests/vault-note-revisions.test.ts`
- Modify: `src/status-server/routes/assistant/helpers.ts`, `src/status-server/routes/assistant.ts`

- [x] **Step 1: Change the revision-conflict test to read the wire details**

In `tests/vault-note-revisions.test.ts`, the stale-revision assertion becomes:

```ts
  assert.throws(() => store.update(note.id, { body: 'Three.' }, 1, TEST_META),
    (error: Error) => error instanceof VaultConflictError && error.code === 'conflict' && error.details.currentRevision === 2);
```

Add this test:

```ts
test('vault errors carry the assistant wire classes', () => {
  assert.ok(new VaultNotFoundError('x') instanceof AssistantNotFoundError);
  const taken = new VaultTitleTakenError('Git');
  assert.ok(taken instanceof AssistantConflictError);
  assert.equal(taken.code, 'title_taken');
});
```

Add these imports: `AssistantConflictError, AssistantNotFoundError` from `../src/assistant/errors.ts`, and `VaultTitleTakenError` from `../src/vault/errors.ts`.

- [x] **Step 2: Run it to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-note-revisions`
Expected: FAIL, because `error.code` is undefined.

- [x] **Step 3: Implement**

```ts
// src/assistant/errors.ts
/**
 * The two failure classes the assistant control surface distinguishes on the wire. The status
 * server maps them by type, so an error's HTTP status never depends on the wording of its message.
 */
export class AssistantNotFoundError extends Error {}

/** The request named a real thing whose current state forbids the operation. */
export class AssistantConflictError extends Error {
  /** Wire code; a more specific conflict names its own. */
  readonly code: string;
  /** Fields the client needs to recover, sent beside the code and message. */
  readonly details: Readonly<Record<string, number>>;

  constructor(message: string, options: { readonly code?: string; readonly details?: Readonly<Record<string, number>> } = {}) {
    super(message);
    this.code = options.code ?? 'conflict';
    this.details = options.details ?? {};
  }
}
```

```ts
// src/vault/errors.ts
import { AssistantConflictError, AssistantNotFoundError } from '../assistant/errors.ts';

export class VaultNotFoundError extends AssistantNotFoundError {
  constructor(what: string) {
    super(`Vault note not found: ${what}`);
    this.name = 'VaultNotFoundError';
  }
}

export class VaultConflictError extends AssistantConflictError {
  constructor(noteId: string, currentRevision: number) {
    super(`Vault note ${noteId} changed; current revision is ${currentRevision}.`, { details: { currentRevision } });
    this.name = 'VaultConflictError';
  }
}

export class VaultTitleTakenError extends AssistantConflictError {
  constructor(title: string) {
    super(`A vault note titled "${title}" already exists.`, { code: 'title_taken' });
    this.name = 'VaultTitleTakenError';
  }
}

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultValidationError';
  }
}
```

In `helpers.ts`, `sendError` gains a details argument:

```ts
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details: Readonly<Record<string, number>> = {},
): void {
  sendJson(res, status, { error: { ...details, code, message } });
}
```

In `routes/assistant.ts`, the catch block becomes:

```ts
    } else {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AssistantNotFoundError) sendError(res, 404, 'not_found', message);
      else if (error instanceof AssistantConflictError) sendError(res, 409, error.code, message, error.details);
      else sendError(res, 400, 'invalid_request', message);
    }
```

- [x] **Step 4: Run to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-note-revisions`. Expected: PASS.
Also run `node .\src\test-runner\run-tests.ts assistant` and expect PASS: existing conflicts still send `conflict`.

- [x] **Step 5: Checkpoint**: `npm run typecheck` exits 0.

---

### Task 2: DTO schemas, note detail and export format

**Files:**
- Modify: `packages/contracts/src/vault.ts`, `src/vault/note-queries.ts`
- Create: `src/vault/vault-export.ts`
- Test: `tests/vault-export.test.ts`, plus one added case in `tests/vault-note-queries.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// tests/vault-export.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { toMarkdownFile, vaultExportPath } from '../src/vault/vault-export.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

test('a note exports as frontmatter plus its body under its folder', () => withVault(({ store }) => {
  const note = store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Uses** [[Git]]', { aliases: ['VS Code'], tags: ['Editor'] }), TEST_META);
  assert.equal(vaultExportPath(note), 'Software/Visual Studio Code.md');
  assert.equal(toMarkdownFile(note), [
    '---',
    'kind: entity',
    'types: ["software"]',
    'aliases: ["VS Code"]',
    'tags: ["editor"]',
    'revision: 1',
    'updated: 2026-10-24T09:00:00.000Z',
    '---',
    '',
    'Editor.',
    '',
    '**Uses** [[Git]]',
    '',
  ].join('\n'));
  assert.equal(vaultExportPath(store.create(entityInput('Inbox note', 'x', { folder: '' }), TEST_META)), 'Inbox note.md');
}));
```

Append to `tests/vault-note-queries.test.ts`:

```ts
test('detail bundles the note with its backlinks and outgoing links', () => withVault(({ store, database }) => {
  const { me, vscode } = seed(store);
  const detail = new VaultNoteQueries(database).detail(vscode.id);
  assert.equal(detail.note.id, vscode.id);
  assert.deepEqual(detail.backlinks.map((link) => link.note.id)[0], me.id);
  assert.deepEqual(detail.outgoing.unresolved, ['nowhere']);
}));
```

- [x] **Step 2: Run them to verify they fail**

Run `node .\src\test-runner\run-tests.ts vault-export`; expect FAIL with "module not found".
Run `node .\src\test-runner\run-tests.ts vault-note-queries`; expect FAIL with "detail is not a function".

- [x] **Step 3: Implement**

Append to `packages/contracts/src/vault.ts`:

```ts
const ExpectedRevisionSchema = z.number().int().min(1);

export const VaultTreeResponseSchema = z.object({ folders: z.array(VaultFolderSchema) }).strict();
export type VaultTreeResponse = z.infer<typeof VaultTreeResponseSchema>;

export const VaultNoteListResponseSchema = z.object({ notes: z.array(VaultNoteSummarySchema) }).strict();
export type VaultNoteListResponse = z.infer<typeof VaultNoteListResponseSchema>;

export const VaultNoteDetailSchema = z.object({
  note: VaultNoteSchema,
  backlinks: z.array(VaultBacklinkSchema),
  outgoing: VaultOutgoingSchema,
}).strict();
export type VaultNoteDetail = z.infer<typeof VaultNoteDetailSchema>;

export const VaultResolveResponseSchema = z.object({ id: z.string().nullable() }).strict();
export type VaultResolveResponse = z.infer<typeof VaultResolveResponseSchema>;

export const VaultRevisionListResponseSchema = z.object({ revisions: z.array(VaultRevisionSummarySchema) }).strict();
export type VaultRevisionListResponse = z.infer<typeof VaultRevisionListResponseSchema>;

export const VaultCreateNoteRequestSchema = z.object({
  title: z.string(),
  folder: z.string().default(''),
  body: z.string().default(''),
}).strict();

export const VaultUpdateNoteRequestSchema = VaultNotePatchSchema.extend({ expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultRenameRequestSchema = z.object({ title: z.string(), expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultDeleteRequestSchema = z.object({ expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultRestoreRequestSchema = z.object({ revision: z.number().int().min(1), expectedRevision: ExpectedRevisionSchema }).strict();
export const VaultDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
```

In `src/vault/note-queries.ts`, add `type VaultNoteDetail` to the contracts import, and add these methods after `outgoing` (`allNotes` feeds the export; `AssistantService` exposes no raw database):

```ts
  allNotes(): VaultNote[] {
    return z.array(VaultNoteRowSchema).parse(this.database.prepare('SELECT * FROM vault_notes ORDER BY folder, title_key').all()).map(toVaultNote);
  }

  detail(noteId: string): VaultNoteDetail {
    return { note: requireVaultNote(this.database, noteId), backlinks: this.backlinks(noteId), outgoing: this.outgoing(noteId) };
  }
```

```ts
// src/vault/vault-export.ts
import type { VaultNote } from '@siftkit/contracts';

import { TempArchiveBuilder, type TempArchive } from '../assistant/control/temp-archive.ts';

/** Titles are unique and already exclude path characters, so `folder/title.md` never collides. */
export const vaultExportPath = (note: VaultNote): string => [note.folder, `${note.title}.md`].filter((part) => part.length > 0).join('/');

/** JSON lists are valid YAML, so frontmatter needs no YAML escaping rules of its own. */
export function toMarkdownFile(note: VaultNote): string {
  const frontmatter = [
    `kind: ${note.kind}`,
    `types: ${JSON.stringify(note.types)}`,
    `aliases: ${JSON.stringify(note.aliases)}`,
    `tags: ${JSON.stringify(note.tags)}`,
    `revision: ${note.revision}`,
    `updated: ${note.updatedAtUtc}`,
  ];
  return ['---', ...frontmatter, '---', '', note.body, ''].join('\n');
}

export function exportVault(notes: readonly VaultNote[]): TempArchive {
  const builder = new TempArchiveBuilder('siftkit-vault-export-');
  try {
    for (const note of notes) builder.writer.addBuffer(vaultExportPath(note), Buffer.from(toMarkdownFile(note), 'utf8'));
    return builder.finish();
  } catch (error) {
    builder.cleanup();
    throw error;
  }
}
```

- [x] **Step 4: Run to verify they pass**: `vault-export` and `vault-note-queries` PASS.

- [x] **Step 5: Checkpoint**: `npm run typecheck` exits 0.

---

### Task 3: Service composition and routes

**Files:**
- Modify: `src/assistant/assistant-service.ts`, `src/status-server/routes/assistant/helpers.ts`, `src/status-server/routes/assistant.ts`
- Create: `src/status-server/routes/assistant/vault-routes.ts`
- Test: `tests/vault-routes.test.ts`

- [x] **Step 1: Write the failing E2E tests**

```ts
// tests/vault-routes.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VaultDeleteResponseSchema, VaultGraphSchema, VaultNoteDetailSchema, VaultNoteListResponseSchema, VaultNoteSchema,
  VaultRenameResultSchema, VaultResolveResponseSchema, VaultReviewSchema, VaultRevisionListResponseSchema,
  VaultRevisionSchema, VaultSearchResultSchema, VaultStatsSchema, VaultTreeResponseSchema,
} from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { readArchiveEntriesFromBytes } from './helpers/archive-bytes.ts';
import { withAssistantServer, type AssistantServerHarness } from './helpers/assistant-server-harness.ts';
import { requestBinary, requestJson } from './helpers/dashboard-http.ts';

const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string(), currentRevision: z.number().optional() }) });
const ENABLED = { ...getDefaultConfig().Assistant, Enabled: true };

function vaultClient({ baseUrl, headers }: AssistantServerHarness) {
  const call = async (method: string, path: string, payload?: object) => requestJson(`${baseUrl}/assistant/vault${path}`, {
    method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    call,
    async ok<T>(method: string, path: string, schema: z.ZodType<T>, payload?: object): Promise<T> {
      const response = await call(method, path, payload);
      assert.equal(response.statusCode, 200, JSON.stringify(response.body));
      return schema.parse(response.body);
    },
    async error(method: string, path: string, status: number, payload?: object) {
      const response = await call(method, path, payload);
      assert.equal(response.statusCode, status, JSON.stringify(response.body));
      return ErrorBodySchema.parse(response.body).error;
    },
  };
}

test('vault routes create, read, link, search, review and graph notes', async () => {
  await withAssistantServer('siftkit-vault-routes-read-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const git = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', folder: 'Software', body: 'Git is a tool.' });
    assert.deepEqual([git.kind, git.revision, git.folder], ['note', 1, 'Software']);
    const siftkit = await vault.ok('POST', '/notes', VaultNoteSchema, {
      title: 'SiftKit', folder: 'Projects',
      body: 'SiftKit is a project.\n\n**Uses** [[Git]] · [[Node.js]]\n\n> [!unverified]- 1 unverified fact\n> - **Runs on** [[Windows]] #unverified',
    });

    assert.deepEqual((await vault.ok('GET', '/tree?stubs=true', VaultTreeResponseSchema)).folders.map((folder) => [folder.path, folder.count]),
      [['Projects', 1], ['Software', 1]]);
    assert.deepEqual((await vault.ok('GET', '/notes?folder=Software', VaultNoteListResponseSchema)).notes.map((note) => note.title), ['Git']);

    const gitDetail = await vault.ok('GET', `/notes/${git.id}`, VaultNoteDetailSchema);
    assert.deepEqual(gitDetail.backlinks.map((link) => [link.note.title, link.labels]), [['SiftKit', ['Uses']]]);
    const siftkitDetail = await vault.ok('GET', `/notes/${siftkit.id}`, VaultNoteDetailSchema);
    assert.deepEqual(siftkitDetail.outgoing.resolved.map((note) => note.title), ['Git']);
    assert.deepEqual(siftkitDetail.outgoing.unresolved, ['node.js', 'windows']);

    assert.deepEqual(await vault.ok('GET', '/resolve?title=GIT', VaultResolveResponseSchema), { id: git.id });
    assert.deepEqual(await vault.ok('GET', '/resolve?title=nope', VaultResolveResponseSchema), { id: null });
    assert.equal((await vault.ok('GET', '/search?q=git', VaultSearchResultSchema)).hits[0]?.note.title, 'Git');
    assert.deepEqual((await vault.ok('GET', '/review', VaultReviewSchema)).items.map((item) => [item.label, item.value]), [['Runs on', '[[Windows]]']]);

    const graph = await vault.ok('GET', '/graph', VaultGraphSchema);
    assert.deepEqual([graph.nodes.length, graph.edges.length], [2, 1]);
    assert.deepEqual((await vault.ok('GET', '/graph?minLinks=1&hide=Projects', VaultGraphSchema)).nodes.map((node) => node.title), ['Git']);
    assert.equal((await vault.ok('GET', `/graph/local/${git.id}?depth=1`, VaultGraphSchema)).nodes.length, 2);

    const stats = await vault.ok('GET', '/stats', VaultStatsSchema);
    assert.deepEqual([stats.notes, stats.links, stats.notesWithUnverified], [2, 3, 1]);
  });
});

test('vault routes update, rename, restore and delete under revision checks', async () => {
  await withAssistantServer('siftkit-vault-routes-write-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const editor = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'VS Code', folder: 'Software', body: 'Editor.' });
    const project = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'SiftKit', body: '**Uses** [[VS Code]]' });

    const updated = await vault.ok('PUT', `/notes/${editor.id}`, VaultNoteSchema, { body: 'Editor by Microsoft.', tags: ['editor'], expectedRevision: 1 });
    assert.deepEqual([updated.revision, updated.tags], [2, ['editor']]);
    assert.deepEqual(await vault.error('PUT', `/notes/${editor.id}`, 409, { body: 'Stale.', expectedRevision: 1 }),
      { code: 'conflict', message: `Vault note ${editor.id} changed; current revision is 2.`, currentRevision: 2 });

    const renamed = await vault.ok('POST', `/notes/${editor.id}/rename`, VaultRenameResultSchema, { title: 'Visual Studio Code', expectedRevision: 2 });
    assert.deepEqual([renamed.rewrittenNotes, renamed.rewrittenLinks, renamed.note.aliases], [1, 1, ['VS Code']]);
    assert.equal((await vault.ok('GET', `/notes/${project.id}`, VaultNoteDetailSchema)).note.body, '**Uses** [[Visual Studio Code]]');

    assert.deepEqual((await vault.ok('GET', `/notes/${editor.id}/revisions`, VaultRevisionListResponseSchema)).revisions.map((revision) => revision.revision), [3, 2, 1]);
    const first = await vault.ok('GET', `/notes/${editor.id}/revisions/1`, VaultRevisionSchema);
    assert.deepEqual([first.title, first.body, first.actor], ['VS Code', 'Editor.', 'you']);

    const restored = await vault.ok('POST', `/notes/${editor.id}/restore`, VaultNoteSchema, { revision: 1, expectedRevision: 3 });
    assert.deepEqual([restored.revision, restored.title, restored.body], [4, 'Visual Studio Code', 'Editor.']);

    assert.deepEqual(await vault.ok('DELETE', `/notes/${editor.id}`, VaultDeleteResponseSchema, { expectedRevision: 4 }), { ok: true });
    assert.equal((await vault.error('GET', `/notes/${editor.id}`, 404)).code, 'not_found');
    assert.deepEqual((await vault.ok('GET', `/notes/${project.id}`, VaultNoteDetailSchema)).outgoing.unresolved, ['visual studio code']);
  });
});

test('vault routes reject bad requests with typed errors', async () => {
  await withAssistantServer('siftkit-vault-routes-errors-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const git = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', body: 'x' });
    assert.equal((await vault.error('POST', '/notes', 409, { title: 'git' })).code, 'title_taken');
    assert.equal((await vault.error('POST', '/notes', 400, { title: 'a|b' })).code, 'invalid_request');
    assert.equal((await vault.error('POST', '/notes', 400, { title: 'Ok', extra: true })).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/notes/vnote_missing', 404)).code, 'not_found');
    assert.equal((await vault.error('GET', `/notes/${git.id}/revisions/9`, 404)).code, 'not_found');
    assert.equal((await vault.error('GET', `/graph/local/${git.id}?depth=3`, 400)).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/tree?stubs=maybe', 400)).code, 'invalid_request');
  });
});

test('vault export zips every note as markdown and keeps working while the assistant is disabled', async () => {
  await withAssistantServer('siftkit-vault-routes-export-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', folder: 'Software', body: 'Git is a tool.' });
    const patched = await requestJson(`${harness.baseUrl}/assistant/config`, {
      method: 'PATCH', headers: harness.headers, body: JSON.stringify({ assistant: { ...ENABLED, Enabled: false } }),
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((await vault.error('GET', '/tree', 409)).code, 'assistant_disabled');

    const exported = await requestBinary(`${harness.baseUrl}/assistant/vault/export`, { method: 'POST', headers: harness.headers });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.contentType, 'application/zip');
    const entries = await readArchiveEntriesFromBytes(exported.body);
    assert.deepEqual([...entries.keys()], ['Software/Git.md']);
    assert.match(entries.get('Software/Git.md')?.toString('utf8') ?? '', /^---\nkind: note\n[\s\S]*---\n\nGit is a tool\.\n$/);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-routes`
Expected: FAIL. Create returns 404 because no route is registered.

- [x] **Step 3: Implement**

In `src/assistant/assistant-service.ts`, add these imports:

```ts
import { VaultGraphQueries } from '../vault/vault-graph.ts';
import { VaultNoteQueries } from '../vault/note-queries.ts';
import { VaultNoteStore } from '../vault/note-store.ts';
import { VaultSearch } from '../vault/vault-search.ts';
```

Add these fields next to `memoryQueries`:

```ts
  readonly vaultNotes: VaultNoteStore;
  readonly vaultQueries: VaultNoteQueries;
  readonly vaultSearch: VaultSearch;
  readonly vaultGraph: VaultGraphQueries;
```

Add this to the constructor, after `this.memoryQueries = ...`:

```ts
    this.vaultNotes = new VaultNoteStore(options.database, options.clock, options.ids);
    this.vaultQueries = new VaultNoteQueries(options.database);
    this.vaultSearch = new VaultSearch(options.database);
    this.vaultGraph = new VaultGraphQueries(options.database);
```

In `helpers.ts`, add after `integerParam`:

```ts
export function booleanParam(url: URL, name: string): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}
```

```ts
// src/status-server/routes/assistant/vault-routes.ts
import {
  VaultCreateNoteRequestSchema, VaultDeleteRequestSchema, VaultRenameRequestSchema, VaultRestoreRequestSchema,
  VaultUpdateNoteRequestSchema,
  type VaultDeleteResponse, type VaultNoteListResponse, type VaultResolveResponse, type VaultRevisionListResponse,
  type VaultTreeResponse, type VaultWriteMeta,
} from '@siftkit/contracts';
import { z } from '../../../lib/zod.ts';
import { exportVault } from '../../../vault/vault-export.ts';
import { sendJson } from '../../http-utils.ts';
import type { RouteMatch } from '../../route-table.ts';
import {
  assistantRoute, body, booleanParam, id, integerParam, sendArchive,
} from './helpers.ts';

const LOCAL_GRAPH_NODE_CAP = 160;
const LocalGraphDepthSchema = z.union([z.literal(1), z.literal(2)]);
const RevisionCaptureSchema = z.coerce.number().int().min(1);

const youMeta = (summary: string): VaultWriteMeta => ({ actor: 'you', summary, sourceRef: null });
const revisionCapture = (match: RouteMatch): number => RevisionCaptureSchema.parse(match.captures[1]);

export const vaultTreeEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultTreeResponse = { folders: service.vaultQueries.folders({ includeStubs: booleanParam(url, 'stubs') }) };
  sendJson(res, 200, response);
});

export const vaultListNotesEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultNoteListResponse = {
    notes: service.vaultQueries.folderNotes(url.searchParams.get('folder') ?? '', {
      includeStubs: booleanParam(url, 'stubs'), limit: integerParam(url, 'limit', 500),
    }),
  };
  sendJson(res, 200, response);
});

export const vaultNoteDetailEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultQueries.detail(id(match)));
});

export const vaultResolveEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultResolveResponse = { id: service.vaultNotes.resolve(url.searchParams.get('title') ?? '')?.id ?? null };
  sendJson(res, 200, response);
});

export const vaultCreateNoteEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, VaultCreateNoteRequestSchema);
  sendJson(res, 200, service.vaultNotes.create(
    { ...request, kind: 'note', types: [], aliases: [], tags: [] }, youMeta('Created'),
  ));
});

export const vaultUpdateNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const { expectedRevision, ...patch } = await body(req, VaultUpdateNoteRequestSchema);
  sendJson(res, 200, service.vaultNotes.update(id(match), patch, expectedRevision, youMeta('Edited')));
});

export const vaultRenameNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRenameRequestSchema);
  sendJson(res, 200, service.vaultNotes.rename(id(match), request.title, request.expectedRevision, youMeta(`Renamed to ${request.title}`)));
});

export const vaultDeleteNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultDeleteRequestSchema);
  service.vaultNotes.delete(id(match), request.expectedRevision);
  const response: VaultDeleteResponse = { ok: true };
  sendJson(res, 200, response);
});

export const vaultRevisionsEndpoint = assistantRoute(({ service, res, match }) => {
  const response: VaultRevisionListResponse = { revisions: service.vaultNotes.listRevisions(id(match)) };
  sendJson(res, 200, response);
});

export const vaultRevisionEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultNotes.getRevision(id(match), revisionCapture(match)));
});

export const vaultRestoreEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRestoreRequestSchema);
  sendJson(res, 200, service.vaultNotes.restore(
    id(match), request.revision, request.expectedRevision, youMeta(`Restored revision ${request.revision}`),
  ));
});

export const vaultSearchEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, service.vaultSearch.search(url.searchParams.get('q') ?? '', integerParam(url, 'limit', 50)));
});

export const vaultGraphEndpoint = assistantRoute(({ service, res, url }) => {
  const hidden = (url.searchParams.get('hide') ?? '').split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0);
  sendJson(res, 200, service.vaultGraph.global({ minLinks: integerParam(url, 'minLinks', 0), hiddenTopFolders: hidden }));
});

export const vaultLocalGraphEndpoint = assistantRoute(({ service, res, match, url }) => {
  const depth = LocalGraphDepthSchema.parse(integerParam(url, 'depth', 1));
  sendJson(res, 200, service.vaultGraph.local(id(match), depth, LOCAL_GRAPH_NODE_CAP));
});

export const vaultReviewEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, service.vaultQueries.review(integerParam(url, 'limit', 200)));
});

export const vaultStatsEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.vaultQueries.stats());
});

/** Export stays reachable with the assistant off, like the legacy export: it is the user's own data. */
export const vaultExportEndpoint = assistantRoute(async ({ service, res }) => {
  await sendArchive(res, exportVault(service.vaultQueries.allNotes()));
}, { requireEnabled: false });
```

Contracts also need `export type VaultDeleteResponse = z.infer<typeof VaultDeleteResponseSchema>;`.

In `routes/assistant.ts`, import the vault endpoints and add these entries to the route table, before `/assistant/history`:

```ts
  { method: 'GET', path: '/assistant/vault/tree', endpoint: vaultTreeEndpoint },
  { method: 'GET', path: '/assistant/vault/notes', endpoint: vaultListNotesEndpoint },
  { method: 'POST', path: '/assistant/vault/notes', endpoint: vaultCreateNoteEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultNoteDetailEndpoint },
  { method: 'PUT', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultUpdateNoteEndpoint },
  { method: 'DELETE', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultDeleteNoteEndpoint },
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/rename$/u, endpoint: vaultRenameNoteEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)\/revisions$/u, endpoint: vaultRevisionsEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)\/revisions\/(\d+)$/u, endpoint: vaultRevisionEndpoint },
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/restore$/u, endpoint: vaultRestoreEndpoint },
  { method: 'GET', path: '/assistant/vault/resolve', endpoint: vaultResolveEndpoint },
  { method: 'GET', path: '/assistant/vault/search', endpoint: vaultSearchEndpoint },
  { method: 'GET', path: '/assistant/vault/graph', endpoint: vaultGraphEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/graph\/local\/([^/]+)$/u, endpoint: vaultLocalGraphEndpoint },
  { method: 'GET', path: '/assistant/vault/review', endpoint: vaultReviewEndpoint },
  { method: 'GET', path: '/assistant/vault/stats', endpoint: vaultStatsEndpoint },
  { method: 'POST', path: '/assistant/vault/export', endpoint: vaultExportEndpoint },
```

- [x] **Step 4: Run to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-routes`
Expected: PASS (4 tests).

- [x] **Step 5: Phase checkpoint**

Run `npm run typecheck` and expect exit 0. Then run `npm test`, which must be all green.
