# Gate D desktop shell — manual smoke checklist

Dev-only; CI never runs this. Run against a temp runtime
(`SIFTKIT_RUNTIME_ROOT`, `SIFTKIT_STATUS_PORT`), never the repository `.siftkit`.

Launch: `npm run desktop:build`, then run
`desktop/src-tauri/target/release/siftkit-assistant-shell.exe`, or install via the NSIS
bundle under `desktop/src-tauri/target/release/bundle/nsis/`.

| # | Check | How | Result (date/initials) |
|---|-------|-----|------------------------|
| 1 | Tray icon visible; tooltip states connection | Launch the shell with the daemon stopped, then started | _unverified_ |
| 2 | Pause works | Tray → Pause observation; confirm no `/assistant/ingest/*` traffic while paused (daemon log) | _unverified_ |
| 3 | Capture is silent | Enable screenshots; watch the screen during a cadence tick — no border, flash, or focus change | _unverified_ |
| 4 | Multi-monitor bounds correct | `CaptureScope: all_monitors`; reveal the stored capture in the dashboard; monitors placed correctly | _unverified_ |
| 5 | Popup paint → `shown` | Make a question eligible; popup appears bottom-right; `assistant_questions.shown_at_utc` set only after the popup painted | _unverified_ |
| 6 | Close-without-answer dismisses | Close the popup; question status becomes `dismissed` | _unverified_ |
| 7 | Quit kills only the shell-spawned daemon | Start with no daemon (shell spawns one) → Quit → daemon gone; start against an external daemon → Quit → daemon still running | _unverified_ |
| 8 | Sign-in startup honored | Toggle the setting; `HKCU\...\Run\SiftKitAssistant` appears/disappears within one poll | _unverified_ |
| 9 | Custody migration | First connect with custody `file` → DPAPI blob written, plaintext key file gone, custody `desktop`; daemon restart re-imports | _unverified_ |

Every row above is **unverified** as of 2026-08-10: this session ran headless and could not
exercise tray/popup/capture visuals. The table exists to be filled in on first manual run.
