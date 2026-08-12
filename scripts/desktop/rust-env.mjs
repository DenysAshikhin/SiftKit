import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CARGO_HOME, RUSTUP_HOME } from './toolchain-paths.mjs';

/**
 * Runs a command with the portable Gate D Rust toolchain scoped to this process only.
 * Nothing here touches the user PATH, registry, or any global rustup/cargo installation.
 */

const toolchainEnv = {
  ...process.env,
  RUSTUP_HOME,
  CARGO_HOME,
  PATH: `${path.join(CARGO_HOME, 'bin')};${process.env.PATH ?? ''}`,
};

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('Usage: node scripts/desktop/rust-env.mjs <command> [args...]');
  process.exit(2);
}

const portable = path.join(CARGO_HOME, 'bin', `${command}.exe`);
const executable = fs.existsSync(portable) ? portable : command;
const result = spawnSync(executable, args, { stdio: 'inherit', env: toolchainEnv });
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
