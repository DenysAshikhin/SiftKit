# Llama.cpp-Style Chat Upgrade Plan

## Summary

Upgrade SiftKit chat from a linear session log into a graph-backed conversation workspace that preserves the current SiftKit visual theme while adding the selected `llama.cpp` WebUI-style capabilities: edit/regenerate branching, richer session UX, turn-scoped attachments, PDF/image ingestion, structured rendering, import/export, URL-prefill, and stronger live chat telemetry.

This is a phased platform upgrade, not a UI-only refresh. The main architectural change is replacing the current linear `messages[]` session model with a first-class conversation DAG plus attachment artifacts and branch state, then rebuilding the dashboard chat UI on top of that foundation.

## Key Changes

### 1. Conversation graph foundation

- Replace the current implicit linear chat model with normalized persisted entities:
  - `chat_session`
  - `chat_message_node`
  - `chat_branch`
  - `chat_attachment`
  - `chat_attachment_artifact`
  - `chat_hidden_tool_context`
- Keep sessions as the top-level user object, but move message history into node records with explicit parent/branch relationships.
- Persist per-session branch state:
  - `activeBranchId`
  - `activeLeafMessageId`
  - branch labels/status metadata
- Define branch semantics explicitly:
  - sending a normal message appends to the active leaf
  - regenerating an assistant message creates a sibling assistant node under the same parent
  - editing a prior user message creates a new descendant branch from that node
  - branch switching changes the rendered active path only; no historical data is deleted
- Preserve existing session-level fields:
  - title
  - preset id
  - plan repo root
  - condensed summary
  - context usage metadata
- Keep plan/repo-search as preset execution families, but commit their outputs into the same graph model so future branching and message actions remain consistent.

### 2. Backend API expansion

- Keep the `/dashboard/chat/sessions` route family, but add graph-aware actions instead of assuming one linear history.
- Add explicit endpoints or action routes for:
  - send message on active branch
  - regenerate assistant from message parent
  - edit/retry from a prior user message
  - switch active branch
  - list alternate branches around a node
  - create pending turn attachments
  - upload attachment content or register pasted content
  - remove/disable pending attachment
  - commit attachment set with a send
  - export session
  - import session
  - fetch runtime chat capabilities
- Extend SSE event vocabulary so the UI can render attachment and preview state, not just answer deltas:
  - `attachment_added`
  - `attachment_processing`
  - `attachment_ready`
  - `attachment_failed`
  - `thinking`
  - `answer`
  - `preview_ready`
  - `branch_updated`
  - `done`
  - `error`
- Keep current streaming behavior for direct chat, plan, and repo-search, but ensure the final SSE payload includes:
  - committed message node id
  - active branch id
  - active leaf id
  - updated context usage
  - attached artifact metadata
- Add capability discovery derived from runtime config and backend health:
  - attachments enabled
  - PDF extraction available
  - image input available for the current global model/runtime
  - safe HTML preview enabled
  - structured-output support available for the active preset
  - math rendering enabled in dashboard
- Preserve preset-driven behavior:
  - no per-chat model switching
  - no direct per-chat sampling editing
  - preset determines execution family, prompt prefix, allowed tools, and any structured-output behavior

### 3. Attachment and multimodal pipeline

- Implement turn-scoped attachment handling as the default and only initial behavior.
- Support four ingestion paths:
  - file picker
  - drag/drop
  - pasted text/file payloads
  - image paste where supported by the browser
- Attachment types in scope:
  - plain text files
  - PDFs
  - images
- Define attachment processing behavior:
  - text files become extracted text artifacts
  - PDFs default to extracted text artifacts
  - images are only sent as vision inputs when capability detection says the runtime supports them
  - unsupported attachments fail early with explicit UI state
- Persist attachment records separately from messages so pending-turn and committed-turn attachments are both representable.
- Each attachment should track:
  - source type
  - original filename/media type
  - upload state
  - extraction state
  - extracted text or derived artifact ref
  - token estimate
  - preview eligibility
  - validation/failure reason
- Add pre-send attachment review UI:
  - visible tray in composer
  - remove action
  - disable/include toggle
  - token estimate
  - processing spinner/error chip
- Add context-budget accounting that includes attachment artifacts before send and committed attachment artifacts after send.
- Keep hidden tool context separate from user-facing attachments so repo-search/plan evidence does not leak into normal attachment UX.

### 4. Dashboard chat rebuild

- Keep the current SiftKit visual language:
  - same dark palette family
  - same panel framing
  - same typography direction
  - same dashboard shell
- Rebuild the chat tab into a workspace with three stronger areas:
  - richer session rail
  - branch-aware conversation pane
  - composer with attachment tray
- Session rail changes:
  - show session title, updated time, preset badge
  - show branch count or branch indicator
  - show attachment/pending-state indicators
  - support rename, duplicate, export, delete
- Conversation pane changes:
  - render only the active branch path from root to active leaf
  - expose inline branch controls where alternates exist
  - expose message actions:
    - copy
    - quote
    - inspect metadata
    - edit
    - regenerate
  - render assistant thinking as expandable detail
  - render preview cards and structured-output cards when present
- Composer changes:
  - preserve preset-driven send behavior
  - add attachment tray above or beside input
  - show active preset and any capability restrictions
  - keep repo-search/plan controls compatible with current preset-driven tool flows
- Branch UX:
  - inline sibling selector on assistant turns with alternates
  - inline edited-branch selector on user turns with descendants
  - session-level branch status indicator showing current branch path position
- Telemetry/live state:
  - improve stream state so users can see attachment processing, thinking, answer assembly, preview generation, and context pressure in one place
  - keep existing token/cache signals, but attach them to the active stream state and committed node metadata
- Add empty/loading/error states that match the current theme rather than feeling like default form scaffolding.

### 5. Rich rendering and portability

- Add math rendering for assistant markdown output.
- Add safe HTML/JS preview for assistant outputs that are explicitly marked previewable.
- Preview execution requirements:
  - sandboxed iframe/container
  - no privileged access to dashboard runtime
  - explicit preview card instead of auto-executing arbitrary output inline
- Add structured-output rendering:
  - when a preset or response indicates constrained JSON output, show a typed JSON/result viewer instead of raw markdown only
- Add session import/export:
  - export full session graph, active branch metadata, messages, attachment metadata, and derived artifact references or embedded portable content as appropriate
  - import must reconstruct the same branch topology deterministically
- Add URL parameter support for:
  - opening chat tab
  - pre-filling prompt text
  - selecting a target session
  - optionally selecting preset when allowed by current dashboard config

### 6. Migration and compatibility

- Add a migration from current `chat_sessions` + linear `chat_messages` records into the new graph schema.
- Migration rules:
  - existing linear histories become one default branch
  - latest message becomes `activeLeafMessageId`
  - existing session `presetId`, `mode`, `planRepoRoot`, `condensedSummary`, and token fields are preserved
  - existing hidden tool contexts remain attached to the migrated session
- Maintain backward compatibility only as far as needed to migrate persisted runtime data once; do not keep long-term dual-write complexity.
- Keep current plan/repo-search request paths operational throughout the migration.
- Split large chat-specific logic out of the current monoliths as part of the implementation:
  - dashboard chat state/rendering should move out of `dashboard/src/App.tsx`
  - backend chat route orchestration should be decomposed from `src/status-server/routes/chat.ts`
  - persistence should evolve from the linear assumptions in `src/state/chat-sessions.ts`

## Public APIs, Types, and Data Contracts

- `ChatSession` gains branch metadata and no longer exposes the conversation as the single source of truth via only `messages[]`.
- Add explicit message-node type with:
  - `id`
  - `sessionId`
  - `parentMessageId`
  - `branchId`
  - `role`
  - `content`
  - `thinkingContent`
  - usage/token fields
  - `createdAtUtc`
  - `status`
  - preview/structured-output metadata
- Add explicit branch type with:
  - `id`
  - `sessionId`
  - `rootMessageId`
  - `leafMessageId`
  - `label`
  - `createdAtUtc`
  - `updatedAtUtc`
- Add explicit attachment type with:
  - `id`
  - `sessionId`
  - `messageNodeId | pendingTurnId`
  - `kind`
  - `filename`
  - `mediaType`
  - `sizeBytes`
  - `status`
  - `tokenEstimate`
  - capability flags
  - failure fields
- Add attachment artifact type with:
  - `attachmentId`
  - `artifactKind`
  - `contentText | fileRef`
  - preview metadata
- Add capability response contract for dashboard chat initialization and preset changes.
- Add export/import payload schema that round-trips:
  - sessions
  - branches
  - message nodes
  - attachments
  - attachment artifacts
  - active branch metadata
- Keep SSE response contracts versioned in code comments/tests so future UI changes do not silently break stream parsing.

## Test Plan

### Backend and persistence

- Migration converts legacy linear sessions into a valid single-branch DAG.
- Migrated sessions preserve title, preset, repo-root, condensed summary, token data, and hidden tool contexts.
- Sending on an active branch appends to the current leaf only.
- Regenerating an assistant turn creates a sibling node and updates active branch/leaf deterministically.
- Editing a prior user turn creates a new descendant branch without deleting prior descendants.
- Branch switching returns the correct active path and leaf.
- Plan/repo-search responses still persist and render correctly after the graph migration.
- Attachment records persist correctly for pending and committed turns.
- PDF extraction, text extraction, and image capability gating produce expected artifact states.
- Unsupported attachment types fail closed with explicit error state.
- Export/import round-trips branch topology and attachment metadata without ambiguity.

### Streaming and API behavior

- SSE event order is stable for normal chat sends.
- SSE event order is stable when attachments require processing before generation.
- Final stream payload includes committed node id, active branch id, active leaf id, and context usage.
- Error events surface attachment failures, extraction failures, preview failures, and generation failures distinctly.
- Capability endpoint changes correctly when preset changes or runtime health changes.

### Dashboard behavior

- Session rail reflects branch/activity/attachment indicators correctly.
- Active branch path renders correctly after send, regenerate, edit, and branch switch.
- Message actions trigger the correct backend action and preserve prior history.
- Attachment tray supports add, remove, disable, and pre-send review.
- Drag/drop and paste flows produce the same pending attachment state as file-picker uploads.
- Math rendering works inside assistant markdown without breaking existing markdown rendering.
- HTML/JS preview only appears for eligible messages and stays sandboxed.
- Structured-output responses render in the specialized viewer when present and fall back safely otherwise.
- Import/export UI restores a conversation graph that matches the exported session.
- URL-prefill opens the chat tab and seeds the composer/session selection correctly.

### Coverage focus

- TDD for each phase.
- New graph logic must have branch-heavy tests, not just happy-path linear coverage.
- Attachment processing must include failure-path tests for parse errors, unsupported media, missing capability, and oversized inputs.
- Dashboard interaction tests should cover edit/regenerate branch creation because that is the main behavioral regression risk.

## Assumptions and Defaults

- Mobile-specific UI optimization is out of scope.
- Per-chat model switching is out of scope.
- Sampling remains preset-driven only; chat can display preset/runtime-derived behavior but cannot directly edit sampling values.
- Attachments are turn-scoped by default and are not silently carried into later turns.
- Branching is a first-class DAG, not hidden version history.
- PDFs default to text extraction, not image/OCR-first behavior.
- Images are only included when runtime capability explicitly allows multimodal input for the current global model/runtime.
- The implementation should preserve the current SiftKit theme and avoid introducing a visually separate mini-app inside the dashboard.
- The work should be delivered in phases:
  - Phase 1: schema/migration/API foundation
  - Phase 2: branch-aware dashboard rebuild
  - Phase 3: attachment and multimodal ingestion
  - Phase 4: math/preview/import-export/URL support
  - Phase 5: hardening and regression coverage
