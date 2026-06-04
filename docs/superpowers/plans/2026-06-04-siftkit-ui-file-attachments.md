# SiftKit UI File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SiftKit dashboard file attachment support for drag/drop and a `+` composer menu, with text/document extraction always available and image attachments conditionally available when the active managed llama preset has an `mmproj` configured and loaded.

**Architecture:** Text/document files are extracted through a server endpoint as soon as files are added. Image files are converted in the browser to base64 data URL strings and sent as OpenAI-compatible `image_url` content parts only when the active model supports image input. The composer stores pending attachment state, sends ready attachments with chat/plan/repo-search payloads, and the server persists attachment metadata plus extracted text or image data URL on the committed user message. Prompt construction and replay format text attachments deterministically and preserve image attachments as multimodal content parts.

**Tech Stack:** TypeScript, React, Node HTTP, existing SQLite runtime DB, `officeparser` for modern Office/OpenDocument/PDF extraction, existing test stack (`tsx --test`, dashboard tests, `npm test`, `npm run build`).

---

## File Map

- `package.json`: add `officeparser`.
- `src/status-server/http-utils.ts`: add bounded body read helper for upload-style requests.
- `src/status-server/chat-attachments.ts`: new attachment types, validation, extraction service, prompt formatting helpers.
- `src/status-server/chat.ts`: include attachments in prompt replay, context accounting, and message persistence.
- `src/status-server/routes/chat.ts`: add extraction endpoint and accept attachments on chat/plan/repo-search send routes.
- `src/status-server/config-store.ts`: add managed llama `MmProjPath` config field and expose it in `/config`.
- `src/status-server/managed-llama.ts`: emit `--mmproj <path>` when the active preset configures one.
- `src/state/runtime-db.ts`: add `chat_messages.attachments_json` schema and migration.
- `src/state/chat-sessions.ts`: read/write attachment JSON.
- `dashboard/src/types.ts`: add shared dashboard attachment types and `ChatMessage.attachments`.
- `dashboard/src/api.ts`: add extraction API and include attachments in send payloads.
- `dashboard/src/hooks/useChatComposer.ts`: manage pending attachments and send eligibility.
- `dashboard/src/tabs/ChatTab.tsx`: add `+` menu, file input, drag/drop, tray, and rendered user-message attachment blocks.
- `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`: add `mmproj` path setting to each managed llama preset.
- `dashboard/src/settings-sections.ts`: add settings metadata/help for `mmproj`.
- `dashboard/src/styles.css`: style attachment controls/tray/message blocks within current dark UI.
- Tests:
  - `tests/status-server-chat.test.ts`
  - `tests/dashboard-status-server.test.ts`
  - `dashboard/tests/hooks/useChatComposer.test.tsx`
  - `dashboard/tests/tab-components.test.tsx`

---

## Task 1: Add Attachment Contracts

**Files:**
- Modify: `dashboard/src/types.ts`
- Create: `src/status-server/chat-attachments.ts`
- Test: compile through later tests.

- [ ] **Step 1: Add shared dashboard types**

Add these exports near `ChatMessage` in `dashboard/src/types.ts`:

```ts
export type ChatAttachmentKind = 'text';
export type ChatAttachmentKind = 'text' | 'image';

export type ChatAttachmentSource = 'file';

export type ChatAttachmentStatus = 'ready' | 'failed';

export type ChatTextAttachment = {
  id: string;
  kind: 'text';
  source: ChatAttachmentSource;
  filename: string;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  status: ChatAttachmentStatus;
  tokenEstimate: number;
  extractedText: string;
  error: string | null;
};

export type ChatImageAttachment = {
  id: string;
  kind: 'image';
  source: ChatAttachmentSource;
  filename: string;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  status: ChatAttachmentStatus;
  dataUrl: string;
  error: string | null;
};

export type ChatAttachment = ChatTextAttachment | ChatImageAttachment;

export type ChatAttachmentCapabilities = {
  text: { enabled: true };
  image: { enabled: boolean; reason: string | null };
};
```

Add to `ChatMessage`:

```ts
attachments?: ChatAttachment[];
```

- [ ] **Step 2: Add backend attachment module skeleton**

Create `src/status-server/chat-attachments.ts` with backend-equivalent types and pure helpers:

```ts
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { estimateTokenCount } from '../state/chat-sessions.js';

export type ChatAttachmentKind = 'text' | 'image';
export type ChatAttachmentSource = 'file';
export type ChatAttachmentStatus = 'ready' | 'failed';

export type ChatTextAttachment = {
  id: string;
  kind: 'text';
  source: ChatAttachmentSource;
  filename: string;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  status: ChatAttachmentStatus;
  tokenEstimate: number;
  extractedText: string;
  error: string | null;
};

export type ChatImageAttachment = {
  id: string;
  kind: 'image';
  source: ChatAttachmentSource;
  filename: string;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  status: ChatAttachmentStatus;
  dataUrl: string;
  error: string | null;
};

export type ChatAttachment = ChatTextAttachment | ChatImageAttachment;

export type AttachmentExtractionInput = {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  bytes: Buffer;
};

export class UnsupportedAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAttachmentError';
  }
}

export class AttachmentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentExtractionError';
  }
}

export function getAttachmentExtension(filename: string): string {
  const extension = path.extname(String(filename || '').trim()).toLowerCase();
  return extension.startsWith('.') ? extension.slice(1) : extension;
}

export function normalizeAttachmentFilename(filename: string): string {
  const base = path.basename(String(filename || '').trim());
  return base || 'attachment';
}

export function buildReadyTextAttachment(input: {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  extractedText: string;
}): ChatAttachment {
  const filename = normalizeAttachmentFilename(input.filename);
  const extractedText = String(input.extractedText || '').trim();
  return {
    id: crypto.randomUUID(),
    kind: 'text',
    source: 'file',
    filename,
    mediaType: String(input.mediaType || 'application/octet-stream').trim() || 'application/octet-stream',
    extension: getAttachmentExtension(filename),
    sizeBytes: Math.max(0, Math.trunc(Number(input.sizeBytes) || 0)),
    status: 'ready',
    tokenEstimate: estimateTokenCount(extractedText),
    extractedText,
    error: null,
  };
}
```

- [ ] **Step 3: Run typecheck after later tasks add imports**

Run after Task 3:

```powershell
npm run build
```

Expected: initial failures only from not-yet-implemented functions if run before later tasks; full pass after Task 9.

---

## Task 2: Add Persistence Schema And Round Trip

**Files:**
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/chat-sessions.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write failing persistence test**

Add a test near existing `appendChatMessagesWithUsage` tests:

```ts
test('appendChatMessagesWithUsage persists user message attachments', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-attachments-'));
  const session = createSession();
  const attachment = buildReadyTextAttachment({
    filename: 'notes.md',
    mediaType: 'text/markdown',
    sizeBytes: 12,
    extractedText: '# Notes\n\nBody',
  });

  const updated = appendChatMessagesWithUsage(
    runtimeRoot,
    session,
    'Read this.',
    'Done.',
    {},
    { turns: [], attachments: [attachment] },
  );
  const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, String(updated.id)));

  assert.ok(loaded);
  assert.deepEqual(loaded.messages?.[0]?.attachments, [attachment]);
});
```

Add imports if missing:

```ts
import { buildReadyTextAttachment } from '../src/status-server/chat-attachments.js';
import { getChatSessionPath, readChatSessionFromPath } from '../src/state/chat-sessions.js';
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: FAIL because `AppendChatOptions` does not accept `attachments` and persistence drops the field.

- [ ] **Step 3: Add schema column**

In `src/state/runtime-db.ts`:

```ts
export const CURRENT_SCHEMA_VERSION = 29;
```

Add to base `chat_messages` table:

```sql
attachments_json TEXT NOT NULL DEFAULT '[]',
```

Place it after `content TEXT NOT NULL`.

Add migration after version 28:

```ts
if (currentVersion < 29) {
  if (!tableHasColumn(database, 'chat_messages', 'attachments_json')) {
    database.exec("ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';");
  }
  setSchemaVersion(database, 29);
  currentVersion = 29;
}
```

- [ ] **Step 4: Read and write `attachments_json`**

In `src/state/chat-sessions.ts`:

Add to `MessageRow`:

```ts
attachments_json: string;
```

Include `attachments_json` in `SELECT` after `content`.

Add helper:

```ts
function parseAttachmentsJson(value: string | null): unknown[] {
  if (!value || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

Map read rows:

```ts
attachments: parseAttachmentsJson(message.attachments_json),
```

Include `attachments_json` in `INSERT INTO chat_messages` after `content`, add one `?` in `VALUES`, and pass:

```ts
JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
```

- [ ] **Step 5: Extend append options**

In `src/status-server/chat.ts`, add to `AppendChatOptions`:

```ts
attachments?: ChatAttachment[];
```

Import:

```ts
import type { ChatAttachment } from './chat-attachments.js';
```

In the pushed user message, add:

```ts
attachments: Array.isArray(options.attachments) ? options.attachments : [],
```

- [ ] **Step 6: Verify persistence test passes**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: PASS for the new test and existing status-server chat tests.

---

## Task 3: Add Managed Llama MmProj Setting

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/status-server/managed-llama.ts`
- Test: `tests/managed-llama-args.test.ts`

Image attachments are conditionally supported. They require the active managed llama preset to configure a multimodal projector file and the managed llama server to start with that projector loaded.

- [ ] **Step 1: Write failing managed-llama arg test**

In `tests/managed-llama-args.test.ts`, add a test near existing `buildManagedLlamaArgs` tests:

```ts
test('buildManagedLlamaArgs includes mmproj when configured', () => {
  const args = buildManagedLlamaArgs({
    ...createManagedLlamaConfig(),
    MmProjPath: 'C:\\models\\mmproj-qwen3.5.gguf',
  });

  assert.deepEqual(args.slice(args.indexOf('--mmproj'), args.indexOf('--mmproj') + 2), [
    '--mmproj',
    'C:\\models\\mmproj-qwen3.5.gguf',
  ]);
});

test('buildManagedLlamaArgs omits mmproj when empty', () => {
  const args = buildManagedLlamaArgs({
    ...createManagedLlamaConfig(),
    MmProjPath: '',
  });

  assert.equal(args.includes('--mmproj'), false);
});
```

Use the existing config fixture/helper names in the test file; do not introduce duplicate helpers if one already exists.

- [ ] **Step 2: Run failing arg tests**

```powershell
npm test -- managed-llama-args.test.ts
```

Expected: FAIL because `MmProjPath` does not exist and `--mmproj` is not emitted.

- [ ] **Step 3: Add config type/default/resolution**

In `dashboard/src/types.ts`, add to `DashboardManagedLlamaPreset`:

```ts
MmProjPath: string | null;
```

In `src/status-server/config-store.ts`:

Add to `DEFAULT_MANAGED_LLAMA_PRESET`:

```ts
MmProjPath: null,
```

Add to `ManagedLlamaConfig`:

```ts
MmProjPath: string | null;
```

Add to `resolveManagedLlamaSettings()`:

```ts
MmProjPath: typeof preset.MmProjPath === 'string' && preset.MmProjPath.trim()
  ? preset.MmProjPath.trim()
  : null,
```

- [ ] **Step 4: Emit llama-server mmproj arg**

In `src/status-server/managed-llama.ts`, inside `buildManagedLlamaArgs()` after model path args:

```ts
if (typeof config.MmProjPath === 'string' && config.MmProjPath.trim()) {
  args.push('--mmproj', config.MmProjPath.trim());
}
```

This must only apply to managed llama startup. External-server mode cannot prove that an `mmproj` is loaded and should not enable image attachments from this setting.

- [ ] **Step 5: Add settings UI field**

In `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`, add a field near `ModelPath`:

```tsx
{renderField('model-presets', 'MmProj Path', (
  <input
    value={selectedManagedLlamaPreset.MmProjPath || ''}
    onChange={(event) => updateManagedLlamaDraft((preset) => {
      preset.MmProjPath = event.target.value.trim() ? event.target.value : null;
    })}
    placeholder="Optional multimodal projector .gguf path"
  />
))}
```

Use the existing `updateManagedLlamaDraft` mutation style in the file. If the section has a managed file picker pattern for model/executable paths, reuse that pattern and add a picker target only if the current picker API already supports general file targets without broad refactor. Otherwise, use the text input above.

In `dashboard/src/settings-sections.ts`, add a `model-presets` field descriptor:

```ts
{
  label: 'MmProj Path',
  layout: 'half',
  helpText: 'Optional multimodal projector GGUF. Required for image attachments with managed llama. Text attachments do not need this.',
}
```

- [ ] **Step 6: Verify managed llama tests pass**

```powershell
npm test -- managed-llama-args.test.ts
```

Expected: PASS.

---

## Task 4: Implement Text Extraction And Image Preparation Services

**Files:**
- Modify: `package.json`
- Modify: `src/status-server/chat-attachments.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Install parser dependency**

```powershell
npm install officeparser
```

Expected: `package.json` and `package-lock.json` update.

Use `officeparser.parseOfficeAsync(buffer, config)` for modern Office/OpenDocument/PDF extraction. The package documents support for `docx`, `pptx`, `xlsx`, `odt`, `odp`, `ods`, and `pdf`.

- [ ] **Step 2: Write failing extractor tests**

Add tests:

```ts
test('extractTextAttachment reads plain text attachments', async () => {
  const attachment = await extractTextAttachment({
    filename: 'readme.md',
    mediaType: 'text/markdown',
    sizeBytes: 15,
    bytes: Buffer.from('# Title\n\nBody', 'utf8'),
  });

  assert.equal(attachment.status, 'ready');
  assert.equal(attachment.extension, 'md');
  assert.equal(attachment.extractedText, '# Title\n\nBody');
  assert.equal(attachment.error, null);
});

test('extractTextAttachment rejects legacy binary office attachments', async () => {
  await assert.rejects(
    () => extractTextAttachment({
      filename: 'old.doc',
      mediaType: 'application/msword',
      sizeBytes: 4,
      bytes: Buffer.from([0, 1, 2, 3]),
    }),
    UnsupportedAttachmentError,
  );
});

test('extractTextAttachment rejects unsupported media attachments', async () => {
  await assert.rejects(
    () => extractTextAttachment({
      filename: 'photo.png',
      mediaType: 'image/png',
      sizeBytes: 4,
      bytes: Buffer.from([0, 1, 2, 3]),
    }),
    UnsupportedAttachmentError,
  );
});
```

Add image preparation tests:

```ts
test('buildReadyImageAttachment stores data url string', () => {
  const attachment = buildReadyImageAttachment({
    filename: 'screenshot.png',
    mediaType: 'image/png',
    sizeBytes: 4,
    dataUrl: 'data:image/png;base64,AAAA',
  });

  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.dataUrl, 'data:image/png;base64,AAAA');
});

test('buildReadyImageAttachment rejects non-data-url payloads', () => {
  assert.throws(
    () => buildReadyImageAttachment({
      filename: 'screenshot.png',
      mediaType: 'image/png',
      sizeBytes: 4,
      dataUrl: 'AAAA',
    }),
    UnsupportedAttachmentError,
  );
});
```

Import:

```ts
import {
  UnsupportedAttachmentError,
  extractTextAttachment,
} from '../src/status-server/chat-attachments.js';
```

- [ ] **Step 3: Run failing extractor tests**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: FAIL because `extractTextAttachment` is not implemented.

- [ ] **Step 4: Implement extractor classes explicitly**

Extend `src/status-server/chat-attachments.ts`:

```ts
const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'html', 'htm',
  'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'ps1', 'bat', 'cmd',
  'sh', 'yaml', 'yml', 'toml', 'ini', 'sql', 'rs', 'go', 'java', 'c', 'cc', 'cpp',
  'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'kts', 'gd',
]);

const OFFICE_TEXT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods']);
const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'ppt', 'xls']);

export function isSupportedTextAttachmentExtension(extension: string): boolean {
  const normalized = String(extension || '').replace(/^\./u, '').toLowerCase();
  return PLAIN_TEXT_EXTENSIONS.has(normalized) || OFFICE_TEXT_EXTENSIONS.has(normalized);
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isSupportedImageAttachmentExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(String(extension || '').replace(/^\./u, '').toLowerCase());
}

export function buildReadyImageAttachment(input: {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataUrl: string;
}): ChatImageAttachment {
  const filename = normalizeAttachmentFilename(input.filename);
  const dataUrl = String(input.dataUrl || '').trim();
  if (!/^data:image\/[a-z0-9.+-]+;base64,/iu.test(dataUrl)) {
    throw new UnsupportedAttachmentError('Image attachments must be base64 data URL strings.');
  }
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    source: 'file',
    filename,
    mediaType: String(input.mediaType || 'application/octet-stream').trim() || 'application/octet-stream',
    extension: getAttachmentExtension(filename),
    sizeBytes: Math.max(0, Math.trunc(Number(input.sizeBytes) || 0)),
    status: 'ready',
    dataUrl,
    error: null,
  };
}

type TextAttachmentExtractor = {
  canExtract(extension: string): boolean;
  extract(input: AttachmentExtractionInput): Promise<string>;
};

export class PlainTextAttachmentExtractor implements TextAttachmentExtractor {
  canExtract(extension: string): boolean {
    return PLAIN_TEXT_EXTENSIONS.has(extension);
  }

  async extract(input: AttachmentExtractionInput): Promise<string> {
    return input.bytes.toString('utf8').replace(/^\uFEFF/u, '').trim();
  }
}

export class OfficeAttachmentExtractor implements TextAttachmentExtractor {
  canExtract(extension: string): boolean {
    return OFFICE_TEXT_EXTENSIONS.has(extension);
  }

  async extract(input: AttachmentExtractionInput): Promise<string> {
    const officeParser = await import('officeparser');
    const parser = officeParser.default ?? officeParser;
    const parseOfficeAsync = parser.parseOfficeAsync as (buffer: Buffer, config?: {
      outputErrorToConsole?: boolean;
      newlineDelimiter?: string;
      ignoreNotes?: boolean;
      putNotesAtLast?: boolean;
    }) => Promise<string>;
    const text = await parseOfficeAsync(input.bytes, {
      outputErrorToConsole: false,
      newlineDelimiter: '\n',
      ignoreNotes: false,
      putNotesAtLast: false,
    });
    return String(text || '').trim();
  }
}

export class UnsupportedAttachmentExtractor implements TextAttachmentExtractor {
  canExtract(): boolean {
    return true;
  }

  async extract(input: AttachmentExtractionInput): Promise<string> {
    const extension = getAttachmentExtension(input.filename);
    if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
      throw new UnsupportedAttachmentError(
        `Legacy .${extension} files are not supported by the local Node extractor. Convert the file to a modern Office format first.`,
      );
    }
    throw new UnsupportedAttachmentError(`Unsupported attachment type: .${extension || 'unknown'}.`);
  }
}

const TEXT_ATTACHMENT_EXTRACTORS: TextAttachmentExtractor[] = [
  new PlainTextAttachmentExtractor(),
  new OfficeAttachmentExtractor(),
  new UnsupportedAttachmentExtractor(),
];

export async function extractTextAttachment(input: AttachmentExtractionInput): Promise<ChatAttachment> {
  const filename = normalizeAttachmentFilename(input.filename);
  const extension = getAttachmentExtension(filename);
  const extractor = TEXT_ATTACHMENT_EXTRACTORS.find((candidate) => candidate.canExtract(extension));
  if (!extractor) {
    throw new UnsupportedAttachmentError(`Unsupported attachment type: .${extension || 'unknown'}.`);
  }
  try {
    const extractedText = await extractor.extract({ ...input, filename });
    if (!extractedText.trim()) {
      throw new AttachmentExtractionError(`No extractable text found in ${filename}.`);
    }
    return buildReadyTextAttachment({
      filename,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      extractedText,
    });
  } catch (error) {
    if (error instanceof UnsupportedAttachmentError || error instanceof AttachmentExtractionError) {
      throw error;
    }
    throw new AttachmentExtractionError(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 5: Verify extractor tests pass**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: PASS.

---

## Task 5: Add Bounded Body Reader

**Files:**
- Modify: `src/status-server/http-utils.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add failing endpoint test after Task 5 route is stubbed**

This test is written in Task 5 after the route exists. Keep this task implementation ready first.

- [ ] **Step 2: Implement bounded reader**

In `src/status-server/http-utils.ts`:

```ts
import * as http from 'node:http';

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readBodyLimited(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

If `http-utils.ts` already imports `http`, merge imports instead of duplicating.

---

## Task 6: Add Attachment Extraction Endpoint

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests near existing dashboard chat route tests:

```ts
test('dashboard extracts text attachments without persisting file bytes', async () => {
  const harness = await startStatusServerHarness();
  try {
    const response = await requestJson<{ attachment: ChatAttachment }>(
      harness.baseUrl,
      '/dashboard/chat/attachments/extract?filename=notes.md&mediaType=text%2Fmarkdown',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: '# Notes\n\nBody',
      },
    );

    assert.equal(response.attachment.filename, 'notes.md');
    assert.equal(response.attachment.extension, 'md');
    assert.equal(response.attachment.extractedText, '# Notes\n\nBody');
    assert.equal(response.attachment.status, 'ready');
  } finally {
    await harness.close();
  }
});

test('dashboard rejects unsupported attachments with 415', async () => {
  const harness = await startStatusServerHarness();
  try {
    const response = await requestRaw(
      harness.baseUrl,
      '/dashboard/chat/attachments/extract?filename=photo.png&mediaType=image%2Fpng',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: 'png',
      },
    );

    assert.equal(response.statusCode, 415);
    assert.match(response.body, /Unsupported attachment type/u);
  } finally {
    await harness.close();
  }
});
```

Use the existing harness/helper names in `tests/dashboard-status-server.test.ts`; do not introduce a parallel server harness.

- [ ] **Step 2: Run failing route tests**

```powershell
npm test -- dashboard-status-server.test.ts
```

Expected: FAIL because the endpoint does not exist.

- [ ] **Step 3: Implement route**

In `src/status-server/routes/chat.ts`, import:

```ts
import {
  BodyTooLargeError,
  readBodyLimited,
} from '../http-utils.js';
import {
  AttachmentExtractionError,
  UnsupportedAttachmentError,
  extractTextAttachment,
} from '../chat-attachments.js';
```

If `readBody`/`parseJsonBody`/`sendJson` are already imported from `http-utils.js`, add the new exports to that import.

Add near other chat route blocks:

```ts
const MAX_ATTACHMENT_UPLOAD_BYTES = 100 * 1024 * 1024;
```

Add route before session-id routes:

```ts
if (req.method === 'POST' && pathname === '/dashboard/chat/attachments/extract') {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const filename = String(requestUrl.searchParams.get('filename') || '').trim();
  const mediaType = String(requestUrl.searchParams.get('mediaType') || 'application/octet-stream').trim();
  if (!filename) {
    sendJson(res, 400, { error: 'Expected filename.' });
    return true;
  }
  try {
    const bytes = await readBodyLimited(req, MAX_ATTACHMENT_UPLOAD_BYTES);
    if (bytes.length === 0) {
      sendJson(res, 400, { error: 'Expected non-empty attachment body.' });
      return true;
    }
    const attachment = await extractTextAttachment({
      filename,
      mediaType,
      sizeBytes: bytes.length,
      bytes,
    });
    sendJson(res, 200, { attachment });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: error.message });
      return true;
    }
    if (error instanceof UnsupportedAttachmentError) {
      sendJson(res, 415, { error: error.message });
      return true;
    }
    if (error instanceof AttachmentExtractionError) {
      sendJson(res, 422, { error: error.message });
      return true;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
```

- [ ] **Step 4: Verify route tests pass**

```powershell
npm test -- dashboard-status-server.test.ts
```

Expected: PASS for new endpoint tests and existing dashboard server tests.

---

## Task 7: Format Attachments Into Prompts

**Files:**
- Modify: `src/status-server/chat-attachments.ts`
- Modify: `src/status-server/chat.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write failing prompt replay tests**

Add:

```ts
test('buildChatCompletionRequest includes current turn attachment text', () => {
  const attachment = buildReadyTextAttachment({
    filename: 'data.json',
    mediaType: 'application/json',
    sizeBytes: 7,
    extractedText: '{"a":1}',
  });
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'Use this file.', {
    attachments: [attachment],
  });
  const userMessage = request.body.messages.at(-1);

  assert.equal(userMessage.role, 'user');
  assert.match(String(userMessage.content), /Use this file\./u);
  assert.match(String(userMessage.content), /Attached file: data\.json/u);
  assert.match(String(userMessage.content), /\{"a":1\}/u);
});

test('buildChatCompletionRequest replays persisted attachment text', () => {
  const attachment = buildReadyTextAttachment({
    filename: 'notes.md',
    mediaType: 'text/markdown',
    sizeBytes: 5,
    extractedText: 'Persisted file body',
  });
  const session = createSession({
    messages: [{
      id: 'm1',
      role: 'user',
      kind: 'user_text',
      content: 'Earlier text',
      attachments: [attachment],
      inputTokensEstimate: 1,
      outputTokensEstimate: 0,
      thinkingTokens: 0,
      createdAtUtc: new Date().toISOString(),
      sourceRunId: null,
    }],
  });
  const request = buildChatCompletionRequest(createConfig(), session, 'Next');

  assert.match(String(request.body.messages[1].content), /Earlier text/u);
  assert.match(String(request.body.messages[1].content), /Persisted file body/u);
});
```

- [ ] **Step 2: Run failing prompt tests**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: FAIL because prompt formatting ignores attachments.

- [ ] **Step 3: Add prompt formatting helpers**

In `src/status-server/chat-attachments.ts`:

```ts
export function normalizeChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): ChatAttachment | null => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Partial<ChatAttachment>;
      const filename = normalizeAttachmentFilename(String(candidate.filename || 'attachment'));
      const extractedText = String(candidate.extractedText || '').trim();
      if (!extractedText || candidate.status !== 'ready') return null;
      return {
        id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : crypto.randomUUID(),
        kind: 'text',
        source: 'file',
        filename,
        mediaType: String(candidate.mediaType || 'application/octet-stream'),
        extension: getAttachmentExtension(filename),
        sizeBytes: Math.max(0, Math.trunc(Number(candidate.sizeBytes) || 0)),
        status: 'ready',
        tokenEstimate: Math.max(0, Math.trunc(Number(candidate.tokenEstimate) || estimateTokenCount(extractedText))),
        extractedText,
        error: null,
      };
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
}

export function formatAttachmentForPrompt(attachment: ChatAttachment): string {
  return [
    `Attached file: ${attachment.filename}`,
    `Media type: ${attachment.mediaType}`,
    'Extracted text:',
    attachment.extractedText,
  ].join('\n');
}

export function appendAttachmentsToUserContent(content: string, attachments: ChatAttachment[]): string {
  const base = String(content || '').trim();
  const attachmentBlocks = normalizeChatAttachments(attachments).map(formatAttachmentForPrompt);
  if (attachmentBlocks.length === 0) {
    return base;
  }
  return [base, ...attachmentBlocks].filter((value) => value.trim()).join('\n\n');
}
```

- [ ] **Step 4: Wire prompt construction**

In `src/status-server/chat.ts`, import:

```ts
import {
  appendAttachmentsToUserContent,
  normalizeChatAttachments,
  type ChatAttachment,
} from './chat-attachments.js';
```

Update `BuildChatOptions`:

```ts
type BuildChatOptions = {
  thinkingEnabled?: boolean;
  stream?: boolean;
  promptPrefix?: string;
  attachments?: ChatAttachment[];
};
```

Update `formatChatMessageForPrompt` default branch:

```ts
return appendAttachmentsToUserContent(String(message.content || ''), normalizeChatAttachments(message.attachments));
```

Update current user message in `buildChatCompletionRequest`:

```ts
{ role: 'user', content: appendAttachmentsToUserContent(userContent, normalizeChatAttachments(options.attachments)) },
```

Update `getMessageContextTokenEstimate` naturally through `formatChatMessageForPrompt`.

- [ ] **Step 5: Pass attachments through generation calls**

Update function signatures:

```ts
export async function generateChatAssistantMessage(
  config: Dict,
  session: ChatSession,
  userContent: string,
  options: { promptPrefix?: string; attachments?: ChatAttachment[] } = {},
)
```

```ts
export async function streamChatAssistantMessage(
  config: Dict,
  session: ChatSession,
  userContent: string,
  onProgress: ((progress: StreamProgress) => void) | null,
  options: { promptPrefix?: string; attachments?: ChatAttachment[] } = {},
)
```

Pass `attachments: options.attachments` into `buildChatCompletionRequest`.

- [ ] **Step 6: Verify prompt tests pass**

```powershell
npm test -- status-server-chat.test.ts
```

Expected: PASS.

---

## Task 8: Accept Attachments In Chat Routes

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write failing route persistence/send test**

Add a test that creates a session and posts streaming chat with attachments. Use existing `requestSse` helper:

```ts
test('dashboard chat stream sends and persists text attachments', async () => {
  const harness = await startStatusServerHarness();
  try {
    const sessionResponse = await requestJson<ChatSessionResponse>(
      harness.baseUrl,
      '/dashboard/chat/sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Attachments', model: 'local' }),
      },
    );
    const attachment = buildReadyTextAttachment({
      filename: 'notes.md',
      mediaType: 'text/markdown',
      sizeBytes: 9,
      extractedText: 'File body',
    });
    const events = await requestSse(
      harness.baseUrl,
      `/dashboard/chat/sessions/${sessionResponse.session.id}/messages/stream`,
      {
        content: 'Read attached.',
        attachments: [attachment],
      },
    );
    const done = events.find((event) => event.event === 'done');
    assert.ok(done);
    const payload = JSON.parse(done.data) as ChatSessionResponse;
    assert.deepEqual(payload.session.messages[0].attachments, [attachment]);
  } finally {
    await harness.close();
  }
});
```

Use existing mocks in the file for llama responses. If the helper names differ, keep the existing helper style and assertions.

- [ ] **Step 2: Run failing route test**

```powershell
npm test -- dashboard-status-server.test.ts
```

Expected: FAIL because routes ignore attachments.

- [ ] **Step 3: Add route helper**

In `src/status-server/routes/chat.ts`, import:

```ts
import {
  normalizeChatAttachments,
} from '../chat-attachments.js';
```

Add helper:

```ts
function readRequestAttachments(parsedBody: Dict): ReturnType<typeof normalizeChatAttachments> {
  return normalizeChatAttachments(parsedBody.attachments);
}
```

- [ ] **Step 4: Wire direct chat routes**

In non-streaming and streaming `/messages` routes:

```ts
const attachments = readRequestAttachments(parsedBody);
```

Pass into generation:

```ts
const generated = await streamChatAssistantMessage(config, activeSession, userContent, progressHandler, {
  promptPrefix: preset?.promptPrefix || undefined,
  attachments,
});
```

Persist:

```ts
const updatedSession = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, generated.assistantContent, generated.usage, {
  turns: [{ thinkingText: generated.thinkingContent, toolMessages: [] }],
  attachments,
  ...
});
```

Apply the same to non-streaming `generateChatAssistantMessage`.

- [ ] **Step 5: Wire plan and repo-search routes**

For `/plan`, `/plan/stream`, and `/repo-search/stream`:

```ts
const attachments = readRequestAttachments(parsedBody);
const content = appendAttachmentsToUserContent((parsedBody.content as string).trim(), attachments);
```

Use `content` for the actual planner/repo-search prompt.

Persist original user text plus attachments:

```ts
appendChatMessagesWithUsage(
  runtimeRoot,
  activeSessionWithMode,
  (parsedBody.content as string).trim(),
  assistantContent,
  usage,
  { ..., attachments },
);
```

Import `appendAttachmentsToUserContent` from `chat-attachments.js`.

Do not attach files to hidden tool context.

- [ ] **Step 6: Verify route tests pass**

```powershell
npm test -- dashboard-status-server.test.ts
```

Expected: PASS.

---

## Task 9: Add Dashboard API Calls

**Files:**
- Modify: `dashboard/src/api.ts`
- Test: covered through hook tests and build.

- [ ] **Step 1: Add request/response types**

Import `ChatAttachment`.

Add:

```ts
export type ExtractChatAttachmentRequest = {
  file: File;
};

export type ExtractChatAttachmentResponse = {
  attachment: ChatAttachment;
};
```

- [ ] **Step 2: Add extraction function**

```ts
export async function extractChatAttachment(file: File): Promise<ExtractChatAttachmentResponse> {
  const query = new URLSearchParams();
  query.set('filename', file.name);
  query.set('mediaType', file.type || 'application/octet-stream');
  const response = await fetch(`/dashboard/chat/attachments/extract?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<ExtractChatAttachmentResponse>;
}
```

- [ ] **Step 3: Extend send payload types**

Change:

```ts
payload: { content: string }
```

to:

```ts
payload: { content: string; attachments?: ChatAttachment[] }
```

for:
- `appendChatMessage`
- `streamChatMessage`
- `createPlanMessage`
- `streamPlanMessage`
- `streamRepoSearchMessage`

- [ ] **Step 4: Build after hook wiring**

```powershell
npm --prefix dashboard test
```

Expected: PASS after Task 9.

---

## Task 10: Add Composer Attachment State

**Files:**
- Modify: `dashboard/src/hooks/useChatComposer.ts`
- Test: `dashboard/tests/hooks/useChatComposer.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Mock `extractChatAttachment` at top of `useChatComposer.test.tsx`.

Add tests:

```tsx
test('useChatComposer extracts files added to the composer', async () => {
  const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
  mockExtractChatAttachment.mockResolvedValue({
    attachment: {
      id: 'a1',
      kind: 'text',
      source: 'file',
      filename: 'hello.txt',
      mediaType: 'text/plain',
      extension: 'txt',
      sizeBytes: 5,
      status: 'ready',
      tokenEstimate: 2,
      extractedText: 'hello',
      error: null,
    },
  });

  const harness = renderUseChatComposerHarness();
  await act(async () => {
    await harness.result.addFiles([file]);
  });

  assert.equal(harness.result.attachments.length, 1);
  assert.equal(harness.result.attachments[0].status, 'ready');
});

test('useChatComposer sends ready attachments and clears them after success', async () => {
  const harness = renderUseChatComposerHarness();
  harness.result.setChatInput('Read this');
  harness.result.setAttachmentsForTest([READY_ATTACHMENT]);

  await act(async () => {
    await harness.result.sendMessage();
  });

  assert.deepEqual(mockStreamChatMessage.mock.calls[0][1], {
    content: 'Read this',
    attachments: [READY_ATTACHMENT],
  });
  assert.equal(harness.result.attachments.length, 0);
});
```

Use the current testing style in this file; if there is no hook harness, add a minimal component that calls `useChatComposer` and exposes the result through a local variable.

- [ ] **Step 2: Run failing hook tests**

```powershell
npm --prefix dashboard test -- useChatComposer.test.tsx
```

Expected: FAIL because attachment state does not exist.

- [ ] **Step 3: Add hook types**

In `useChatComposer.ts`:

```ts
import { extractChatAttachment } from '../api';
import type { ChatAttachment } from '../types';

export type PendingChatAttachment = ChatAttachment & {
  included: boolean;
  processing: boolean;
};
```

Extend `UseChatComposerResult`:

```ts
attachments: PendingChatAttachment[];
canSendMessage: boolean;
addFiles(files: File[] | FileList): Promise<void>;
removeAttachment(id: string): void;
toggleAttachment(id: string): void;
```

- [ ] **Step 4: Implement explicit hook methods**

Add state:

```ts
const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
```

Add helpers:

```ts
function getReadyIncludedAttachments(): ChatAttachment[] {
  return attachments
    .filter((attachment) => attachment.included && attachment.status === 'ready' && !attachment.processing)
    .map(({ included: _included, processing: _processing, ...attachment }) => attachment);
}

function hasBlockingAttachment(): boolean {
  return attachments.some((attachment) => attachment.processing);
}

function hasSendableContent(): boolean {
  return chatInput.trim().length > 0 || getReadyIncludedAttachments().length > 0;
}
```

Add methods:

```ts
async function addFiles(files: File[] | FileList): Promise<void> {
  const selectedFiles = Array.from(files);
  for (const file of selectedFiles) {
    const temporaryId = `${file.name}-${file.size}-${file.lastModified}`;
    setAttachments((current) => [
      ...current,
      {
        id: temporaryId,
        kind: 'text',
        source: 'file',
        filename: file.name,
        mediaType: file.type || 'application/octet-stream',
        extension: file.name.split('.').pop()?.toLowerCase() || '',
        sizeBytes: file.size,
        status: 'ready',
        tokenEstimate: 0,
        extractedText: '',
        error: null,
        included: true,
        processing: true,
      },
    ]);
    try {
      const response = await extractChatAttachment(file);
      setAttachments((current) => current.map((attachment) => (
        attachment.id === temporaryId
          ? { ...response.attachment, included: true, processing: false }
          : attachment
      )));
    } catch (error) {
      setAttachments((current) => current.map((attachment) => (
        attachment.id === temporaryId
          ? {
              ...attachment,
              status: 'failed',
              processing: false,
              included: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : attachment
      )));
    }
  }
}

function removeAttachment(id: string): void {
  setAttachments((current) => current.filter((attachment) => attachment.id !== id));
}

function toggleAttachment(id: string): void {
  setAttachments((current) => current.map((attachment) => (
    attachment.id === id ? { ...attachment, included: !attachment.included } : attachment
  )));
}
```

- [ ] **Step 5: Include attachments in sends**

For `sendMessage`, `sendPlan`, and `sendRepoSearch`, change guard:

```ts
if (!deps.selectedSession || !hasSendableContent() || hasBlockingAttachment()) {
  return;
}
```

Send:

```ts
const readyAttachments = getReadyIncludedAttachments();
{ content: chatInput.trim(), attachments: readyAttachments }
```

After successful send:

```ts
setChatInput('');
setAttachments([]);
```

Return:

```ts
attachments,
canSendMessage: hasSendableContent() && !hasBlockingAttachment(),
addFiles,
removeAttachment,
toggleAttachment,
```

- [ ] **Step 6: Verify hook tests pass**

```powershell
npm --prefix dashboard test -- useChatComposer.test.tsx
```

Expected: PASS.

---

## Task 11: Wire App Props To ChatTab

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: compile after Task 11.

- [ ] **Step 1: Extend `ChatTabProps`**

Add props:

```ts
attachments: PendingChatAttachment[];
canSendMessage: boolean;
onAddFiles(files: File[] | FileList): Promise<void>;
onRemoveAttachment(id: string): void;
onToggleAttachment(id: string): void;
```

Import `PendingChatAttachment` from `useChatComposer.ts` or move the type to `dashboard/src/types.ts` if the import would create a bad dependency direction. Prefer moving `PendingChatAttachment` to `dashboard/src/types.ts` if needed.

- [ ] **Step 2: Pass props from `App.tsx`**

In the `<ChatTab />` call:

```tsx
attachments={composer.attachments}
canSendMessage={composer.canSendMessage}
onAddFiles={composer.addFiles}
onRemoveAttachment={composer.removeAttachment}
onToggleAttachment={composer.toggleAttachment}
```

---

## Task 12: Add Attachment UI

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/styles.css`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing render tests**

Add tests:

```tsx
test('chat tab renders attachment plus menu with only text enabled', () => {
  const html = renderChatTab({ showAttachmentMenuForTest: true });

  assert.match(html, /Attach text/u);
  assert.match(html, /Image/u);
  assert.match(html, /Audio/u);
  assert.match(html, /Video/u);
  assert.match(html, /disabled/u);
});

test('chat tab renders pending attachment tray', () => {
  const html = renderChatTab({
    attachments: [{
      ...READY_ATTACHMENT,
      included: true,
      processing: false,
    }],
  });

  assert.match(html, /notes\.md/u);
  assert.match(html, /tokens/u);
});

test('chat tab renders persisted user attachments', () => {
  const html = renderChatTab({
    selectedSession: {
      ...CHAT_SESSION,
      messages: [{
        ...CHAT_MESSAGE,
        attachments: [READY_ATTACHMENT],
      }],
    },
  });

  assert.match(html, /Attached files/u);
  assert.match(html, /notes\.md/u);
  assert.match(html, /File body/u);
});
```

Adapt fixture names to existing `tab-components.test.tsx`.

- [ ] **Step 2: Run failing render tests**

```powershell
npm --prefix dashboard test -- tab-components.test.tsx
```

Expected: FAIL because UI does not exist.

- [ ] **Step 3: Add local UI state**

In `ChatTab`:

```tsx
const [attachmentMenuOpen, setAttachmentMenuOpen] = useState<boolean>(false);
const fileInputRef = useRef<HTMLInputElement | null>(null);
const [isDragActive, setIsDragActive] = useState<boolean>(false);
```

Add imports:

```tsx
import { useRef, useState } from 'react';
```

If file currently has no React import for hooks, update the import explicitly.

- [ ] **Step 4: Add `+` menu and file input**

In `.composer-toolbar-left`, before settings:

```tsx
<div className="attachment-menu-wrap">
  <button
    type="button"
    className={attachmentMenuOpen ? 'composer-pill attach active' : 'composer-pill attach'}
    onClick={() => setAttachmentMenuOpen((open) => !open)}
    disabled={chatBusy}
    title="Add attachment"
    aria-label="Add attachment"
  >
    +
  </button>
  {attachmentMenuOpen ? (
    <div className="attachment-menu">
      <button
        type="button"
        onClick={() => {
          setAttachmentMenuOpen(false);
          fileInputRef.current?.click();
        }}
      >
        Text
      </button>
      <button type="button" disabled>Image</button>
      <button type="button" disabled>Audio</button>
      <button type="button" disabled>Video</button>
    </div>
  ) : null}
  <input
    ref={fileInputRef}
    type="file"
    multiple
    className="hidden-file-input"
    onChange={(event) => {
      const files = event.target.files;
      if (files) void onAddFiles(files);
      event.currentTarget.value = '';
    }}
  />
</div>
```

- [ ] **Step 5: Add drag/drop handlers**

Wrap the composer root:

```tsx
<div
  className={isDragActive ? 'composer drag-active' : 'composer'}
  onDragOver={(event) => {
    event.preventDefault();
    setIsDragActive(true);
  }}
  onDragLeave={() => setIsDragActive(false)}
  onDrop={(event) => {
    event.preventDefault();
    setIsDragActive(false);
    if (event.dataTransfer.files.length > 0) {
      void onAddFiles(event.dataTransfer.files);
    }
  }}
>
```

- [ ] **Step 6: Add attachment tray**

Above `<textarea>`:

```tsx
{attachments.length > 0 ? (
  <div className="attachment-tray" aria-label="Pending attachments">
    {attachments.map((attachment) => (
      <div key={attachment.id} className={`attachment-chip ${attachment.status}`}>
        <label>
          <input
            type="checkbox"
            checked={attachment.included}
            onChange={() => onToggleAttachment(attachment.id)}
            disabled={attachment.processing || attachment.status === 'failed'}
          />
          <span>{attachment.filename}</span>
        </label>
        <span>{attachment.processing ? 'processing' : `${formatNumber(attachment.tokenEstimate)} tokens`}</span>
        {attachment.error ? <span className="attachment-error">{attachment.error}</span> : null}
        <button
          type="button"
          className="msg-icon-button danger"
          onClick={() => onRemoveAttachment(attachment.id)}
          aria-label={`Remove ${attachment.filename}`}
          title={`Remove ${attachment.filename}`}
        >
          &#128465;
        </button>
      </div>
    ))}
  </div>
) : null}
```

- [ ] **Step 7: Render persisted user attachments**

Below `<p className="user-message">{message.content}</p>` branch, replace with:

```tsx
<div className="user-message-wrap">
  {message.content ? <p className="user-message">{message.content}</p> : null}
  {Array.isArray(message.attachments) && message.attachments.length > 0 ? (
    <details className="message-attachments">
      <summary>Attached files</summary>
      {message.attachments.map((attachment) => (
        <section key={attachment.id} className="message-attachment-block">
          <header>
            <strong>{attachment.filename}</strong>
            <span>{formatNumber(attachment.tokenEstimate)} tokens</span>
          </header>
          <pre>{attachment.extractedText}</pre>
        </section>
      ))}
    </details>
  ) : null}
</div>
```

- [ ] **Step 8: Update send disabled condition**

Change:

```tsx
disabled={chatBusy || !chatInput.trim()}
```

to:

```tsx
disabled={chatBusy || !canSendMessage}
```

- [ ] **Step 9: Add CSS**

Add to `dashboard/src/styles.css` near composer styles:

```css
.attachment-menu-wrap {
  position: relative;
}

.hidden-file-input {
  display: none;
}

.attachment-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 20;
  min-width: 140px;
  display: grid;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--stroke);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 10px 24px rgb(0 0 0 / 30%);
}

.attachment-menu button {
  justify-content: flex-start;
}

.composer.drag-active {
  outline: 1px solid var(--accent);
  outline-offset: 4px;
}

.attachment-tray {
  display: grid;
  gap: 8px;
}

.attachment-chip {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--stroke);
  border-radius: 8px;
  background: rgb(255 255 255 / 4%);
}

.attachment-chip label {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.attachment-chip label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-chip.failed {
  border-color: var(--danger);
}

.attachment-error {
  color: var(--danger);
}

.user-message-wrap {
  display: grid;
  gap: 8px;
}

.message-attachments {
  border-top: 1px solid var(--stroke);
  padding-top: 8px;
}

.message-attachment-block {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.message-attachment-block header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.85rem;
  color: var(--muted);
}

.message-attachment-block pre {
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
}
```

Use existing CSS variables. If `--danger` does not exist, use the existing error color variable in `styles.css`.

- [ ] **Step 10: Verify UI tests pass**

```powershell
npm --prefix dashboard test -- tab-components.test.tsx
```

Expected: PASS.

---

## Task 13: Full Validation

**Files:**
- All modified files.

- [ ] **Step 1: Run focused backend tests**

```powershell
npm test -- status-server-chat.test.ts dashboard-status-server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run dashboard tests**

```powershell
npm --prefix dashboard test
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Run production build**

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 5: Manual smoke check**

Start the dashboard using the repo's normal start command.

Smoke scenarios:
- Add `.txt`, `.md`, `.json` from the `+` menu.
- Drag/drop one supported text file.
- Send with only an attachment and no typed text.
- Send typed text plus an attachment.
- Confirm committed user bubble shows collapsible attached file content.
- Confirm a follow-up model turn receives prior attachment content through replay.
- Try `.png`, `.mp3`, and `.doc`; confirm clear error chip and send excludes failed attachments.
- Confirm plan and repo-search modes can send attachments.

Expected: all scenarios pass, no binary file copy appears under `.siftkit`.

---

## Task 13: Document The Image Attachment Contract For The Next Phase

**Files:**
- Modify: `docs/superpowers/plans/2026-06-04-siftkit-ui-file-attachments.md`

This task is documentation-only for this plan. Do not enable Image in the v1 UI while the original requirement says only Text is selectable.

- [ ] **Step 1: Preserve v1 behavior**

Keep the `+` menu behavior from Task 11:

```tsx
<button type="button">Text</button>
<button type="button" disabled>Image</button>
<button type="button" disabled>Audio</button>
<button type="button" disabled>Video</button>
```

- [ ] **Step 2: Define the future image payload shape**

When Image is enabled later, do not upload image files as raw binary or multipart to the model endpoint.

The browser should read each image with:

```ts
const reader = new FileReader();
reader.readAsDataURL(file);
```

The attachment should store the resulting data URL string:

```ts
export type ChatImageAttachment = {
  id: string;
  kind: 'image';
  source: 'file';
  filename: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string;
  sizeBytes: number;
  status: 'ready' | 'failed';
  dataUrl: string;
  error: string | null;
};
```

For llama.cpp/OpenAI-compatible chat completions, send image data as an `image_url` content part:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image." },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,<base64-encoded-bytes>"
      }
    }
  ]
}
```

This means the local binary file is converted to a base64 data URL string before send:

```text
image bytes -> base64 -> data:image/<format>;base64,<payload> -> JSON string
```

- [ ] **Step 3: Define image capability gating**

Before enabling Image selection, add runtime capability checks:

```ts
export type ChatImageCapability = {
  enabled: boolean;
  reason: string | null;
};
```

Image is enabled only when the active llama.cpp model/runtime reports image input support. If unsupported, the UI must keep Image disabled and explain that a multimodal model plus projector is required.

- [ ] **Step 4: Define future tests for image support**

When the Image menu item is implemented, add tests that prove:

- image files are read as data URL strings, not posted as multipart data
- the chat request includes `content[]` with `type: "image_url"`
- the data URL begins with `data:image/png;base64,` or the actual file MIME type
- image attachments are blocked when the active model does not support vision
- image bytes are not written to `.siftkit`

---

## Acceptance Criteria

- The composer has a `+` menu with Text enabled and Image/Audio/Video disabled.
- Drag/drop and Text file picker both extract files before send.
- Supported v1 file types:
  - text/code: `.txt`, `.md`, `.markdown`, `.json`, `.jsonl`, `.csv`, `.tsv`, `.log`, `.xml`, `.html`, `.css`, `.js`, `.ts`, `.tsx`, and other explicit code-like text extensions listed in `PLAIN_TEXT_EXTENSIONS`
  - document: `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp`, `.ods`
- Legacy `.doc`, `.ppt`, `.xls` fail with clear unsupported-parser messages.
- Failed attachments remain visible, removable, and excluded from send.
- Binary file bytes are never persisted.
- User messages persist attachment metadata and extracted text.
- Prompt construction includes attachment text for current sends and replayed prior messages.
- Context usage includes attachment text through the existing message token accounting path.
- Chat, plan, and repo-search all support attachments.
- The plan explicitly documents that future image support must send base64 data URL strings in OpenAI-compatible `image_url` content parts, not raw binary.
- Existing tests and build pass.
