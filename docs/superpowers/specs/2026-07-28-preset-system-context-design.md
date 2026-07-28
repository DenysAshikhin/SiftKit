# Preset-Owned System Context Design

## Goal

Make every startup context source preset-owned and place all loaded content in the model's system message. Support an editable per-preset list of individual repository-relative or absolute PC files.

## Product Decisions

- `includeAgentsMd`, `includeRepoFileListing`, and `autoloadFiles` belong to each preset.
- Remove the global `IncludeAgentsMd` and `IncludeRepoFileListing` settings and persistence fields.
- Remove the first-message AGENTS.md and repository-file-list toggles from Chat. A run cannot override its selected preset.
- `autoloadFiles` accepts individual files only.
- Relative paths resolve from the run's repository root. Absolute paths remain absolute.
- Missing, unreadable, or non-file entries are skipped and reported as warnings.
- AGENTS.md, the repository file listing, and configured file contents are labelled and appended to the system prompt before the first model request.
- The initial user message contains only the user's task or input framing. It never contains autoloaded content.
- Direct `summary`, `repo-search`, and `repo-agent` commands resolve the matching preset rather than using removed global defaults. The default summary command resolves the preset marked `useForSummary`.
- No legacy config compatibility is retained. Removed global keys are rejected by the strict schema and unused database columns are removed by a schema migration.

## Architecture

Add a reusable `PresetSystemContextBuilder` class. It receives a repository root and a normalized preset, loads the enabled sources, and returns:

```ts
type PresetSystemContext = {
  content: string;
  warnings: string[];
};
```

The builder owns path resolution, file validation, deterministic ordering, labelled formatting, and warning creation. Existing prompt builders remain responsible only for their execution-family instructions. They receive the built context as text and append it to the system prompt.

Preset resolution remains at execution boundaries:

- `summary` and command-output summary flows use `resolveSummaryPreset`.
- Direct repo search uses the built-in `repo-search` preset.
- Direct repo agent uses the built-in `repo-agent` preset.
- `run --preset` uses the explicitly requested preset.
- Web Chat uses the session's selected preset.

All boundaries call the same context builder before invoking the model.

## Data Model and Persistence

Extend `SiftPreset` and its runtime schema with:

```ts
autoloadFiles: string[];
```

Normalization trims entries, removes empty strings, and deduplicates while preserving first-seen order. Built-in and newly-created presets default to an empty list.

Delete `IncludeAgentsMd` and `IncludeRepoFileListing` from `SiftConfig`, defaults, normalization, strict payload checks, database row mapping, and dashboard general settings. Add a runtime-database schema migration that rebuilds `app_config` without the obsolete columns while preserving current rows.

## Context Formatting

Context sections use stable headers:

```text
--- AGENTS.md (project-specific instructions) ---

<content>

--- Repository file listing (respects ignore policy) ---

<listing>

--- Autoloaded file: <configured path> ---

<content>
```

Sections appear in that order. Configured files retain preset order. Empty files produce an empty-file warning and no section.

The repository listing moves from `buildTaskInitialUserPrompt` into the shared system context. Prompt builders no longer read files themselves.

## Warnings

Each skipped configured file produces one warning containing the configured path and reason. Warnings do not abort the request.

- CLI commands print warnings to stderr even when progress rendering is disabled.
- Streamed web runs emit a `warning` event before model progress. Chat displays each warning as a warning toast.
- Run logs retain the warning event for later inspection.
- Warnings are not inserted into the user message or treated as model instructions.

## Dashboard UI

The Presets editor shows startup-context controls for every preset kind:

- `Load AGENTS.md`
- `Load repository file list`
- `Autoload files`

The file list uses explicit Add and Remove actions. Each row is a text input supporting relative or absolute paths. No directory or glob expansion is offered.

Remove the equivalent global General settings. Remove Chat's first-message autoload preview, token estimates, toggles, hook, API call, and request payload fields.

## Error Handling and Safety

- A nonexistent path, directory, unsupported path, or read error creates a warning and is skipped.
- Relative paths are normalized against the repository root.
- Absolute paths are permitted by product decision.
- Duplicate configured paths are removed during preset normalization.
- Context assembly is deterministic.
- Existing prompt-budget enforcement remains authoritative; autoload content is part of the system prompt and therefore counted normally.

## Testing

Use TDD and emphasize boundary-level tests:

- Contract and preset normalization tests cover defaults, trimming, deduplication, and removed global keys.
- Config-store and database migration tests prove preset lists persist and obsolete columns disappear.
- Context-builder tests use one temporary directory for AGENTS.md, a repository tree, relative files, absolute files, empty files, missing files, and directories.
- Prompt/engine tests prove every source appears only in the system message for summary, plan, repo-search, repo-agent, direct CLI routes, explicit preset runs, and Chat sessions.
- Warning tests prove CLI stderr, streamed web events, toasts, and run logs receive skipped-file warnings.
- Dashboard tests cover add/edit/remove and prove the removed global and Chat controls no longer render.
- Full typecheck, build, tests, and branch coverage validation finish the work.

## Out of Scope

- Directories, globs, recursive configured-file expansion, file watching, per-run overrides, backward-compatible global config aliases, and configurable context ordering.
