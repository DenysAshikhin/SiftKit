# Presets Replace Modes Design

## Goal

Replace hardcoded operation modes such as `summary`, `chat`, `plan`, and `repo-search` with configurable presets that define prompt behavior, tool availability, and surface visibility.

## Core Decisions

- Presets are first-class persisted config.
- User-facing dashboard and CLI select presets by id, not hardcoded modes.
- Presets declare:
  - `id`
  - `label`
  - `description`
  - `executionFamily`
  - `promptPrefix`
  - `allowedTools`
  - `surfaces` (`web`, `cli`)
  - `useForSummary`
  - optional execution defaults such as `maxTurns` and `thinkingInterval`
- Internal execution families remain for now:
  - `summary`
  - `chat`
  - `plan`
  - `repo-search`

## Settings UX

- Add a `Presets` settings section.
- Each preset is editable from settings.
- Each preset can toggle `CLI`, `Web`, or both.
- Dashboard composer shows only `web` presets.
- CLI discovery shows only `cli` presets.

## Session Model

- Sessions store `presetId` instead of a user-facing mode.
- Existing session rows migrate by mapping old modes to built-in preset ids.

## CLI Shape

- Add preset-driven discovery:
  - `siftkit preset list`
  - `siftkit run --preset <id> ...`
- CLI help should point users to dynamic preset discovery.

## Prompt and Tool Behavior

- Summary presets override `promptPrefix` per request.
- Chat presets override the chat system prompt.
- Plan and repo-search presets prepend their prompt prefix before execution.
- Tool allowlists are enforced per execution family:
  - repo-search and plan currently gate `run_repo_cmd`
  - summary planner gates `find_text`, `read_lines`, `json_filter`

## Built-in Presets

- Materialize built-in editable defaults:
  - `summary`
  - `chat`
  - `plan`
  - `repo-search`
- Built-in presets are editable but not deletable.
- User-defined presets are deletable.
- Built-in surface defaults:
  - `summary`: `cli`
  - `repo-search`: `cli`, `web`
  - `chat`: `web`
  - `plan`: `web`

## Migration Scope

- Persist presets in runtime config.
- Extend session persistence with `preset_id`.
- Replace dashboard mode picker with preset picker.
- Expose dynamic CLI preset execution and listing.
