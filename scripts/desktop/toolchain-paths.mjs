import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the portable Gate D Rust toolchain lives. Override with SIFTKIT_TOOLING_ROOT;
 * the default is a `.tooling` directory next to the repository checkout (see
 * docs/superpowers/handoffs/gate-d-toolchain-manifest.md).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TOOLING_ROOT = process.env.SIFTKIT_TOOLING_ROOT
  ?? path.join(path.dirname(repoRoot), '.tooling', 'siftkit-gate-d');
export const RUSTUP_HOME = path.join(TOOLING_ROOT, 'rustup');
export const CARGO_HOME = path.join(TOOLING_ROOT, 'cargo');
