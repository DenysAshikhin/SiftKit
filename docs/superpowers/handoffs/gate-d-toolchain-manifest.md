# Gate D toolchain manifest

**Date installed:** 2026-08-10

## What was installed, and where

Everything Gate D added lives under one directory — `SIFTKIT_TOOLING_ROOT` if set, otherwise
`<repo parent>\.tooling\siftkit-gate-d` (both scripts derive it from
`scripts/desktop/toolchain-paths.mjs`; on the original machine that resolved to
`C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d`):

```
<tooling root>\
├── rustup-init.exe          # the downloaded installer, kept for reproducibility
├── rustup\                  # RUSTUP_HOME: toolchain stable-x86_64-pc-windows-msvc (1.97.1)
└── cargo\                   # CARGO_HOME: cargo registry cache + cargo\bin (cargo, rustc
                             # shims, tauri-cli)
```

- Installed by `npm run desktop:install-toolchain`
  (`scripts/desktop/install-toolchain.mjs`), which runs
  `rustup-init -y --no-modify-path --default-toolchain stable-x86_64-pc-windows-msvc`
  with `RUSTUP_HOME`/`CARGO_HOME` pointed at the directory above.
- `tauri-cli` was installed with
  `node scripts/desktop/rust-env.mjs cargo install tauri-cli --locked`.
- Every `desktop:*` npm script goes through `scripts/desktop/rust-env.mjs`, which sets
  `RUSTUP_HOME`, `CARGO_HOME`, and prepends `cargo\bin` to `PATH` **for that process only**.

## What was NOT touched

- The user `PATH`, system `PATH`, and registry are unmodified (`--no-modify-path`;
  verified after install: `cargo` is not resolvable from a plain shell).
- No `%USERPROFILE%\.rustup` or `%USERPROFILE%\.cargo` was created.

## Pre-existing system components this toolchain relies on

- **Visual Studio 2022 (MSVC link.exe + Windows SDK)** — pre-existing on this machine; the
  MSVC toolchain links against it. Not installed by Gate D, not removed by the steps below.
- **WebView2 runtime** — pre-existing (ships with Windows 11); Tauri's webview host.

## Removal

1. Delete the tooling root directory — this removes rustup, the toolchain, the cargo cache,
   and tauri-cli in one step.
2. Optionally remove the `desktop:*` scripts from `package.json` and
   `scripts/desktop/*.mjs`.

Honest boundary: build artifacts under `desktop/src-tauri/target/` (git-ignored) are also
removable; Visual Studio 2022 and WebView2 are system components that predate Gate D and are
**not** part of this removal.
