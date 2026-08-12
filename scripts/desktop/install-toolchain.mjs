import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CARGO_HOME, RUSTUP_HOME, TOOLING_ROOT } from './toolchain-paths.mjs';

/**
 * Installs a portable Rust toolchain for the Gate D desktop shell under the tooling root.
 * `--no-modify-path` plus process-scoped RUSTUP_HOME/CARGO_HOME keeps the global environment
 * untouched; removal is deleting the tooling root (see
 * docs/superpowers/handoffs/gate-d-toolchain-manifest.md).
 */
const RUSTUP_INIT_URL =
  'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';

fs.mkdirSync(TOOLING_ROOT, { recursive: true });
const rustupInit = path.join(TOOLING_ROOT, 'rustup-init.exe');

if (!fs.existsSync(rustupInit)) {
  console.log(`Downloading ${RUSTUP_INIT_URL}`);
  const response = await fetch(RUSTUP_INIT_URL);
  if (!response.ok) {
    throw new Error(`rustup-init download failed: HTTP ${response.status}`);
  }
  fs.writeFileSync(rustupInit, Buffer.from(await response.arrayBuffer()));
}

console.log(`Installing stable-x86_64-pc-windows-msvc under ${TOOLING_ROOT}`);
const result = spawnSync(rustupInit, [
  '-y',
  '--no-modify-path',
  '--default-toolchain', 'stable-x86_64-pc-windows-msvc',
], {
  stdio: 'inherit',
  env: { ...process.env, RUSTUP_HOME, CARGO_HOME },
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
