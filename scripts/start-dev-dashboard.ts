import { existsSync } from 'node:fs';
import path from 'node:path';

export type DashboardLaunch =
  | { kind: 'script'; script: 'start:dashboard' | 'start:dashboard:stable' }
  | { kind: 'missing_build'; indexPath: string };

/** Stable mode serves the last build, so editing dashboard sources never reloads an open tab. */
export function resolveDashboardLaunch(stable: boolean, repoRoot: string): DashboardLaunch {
  if (!stable) return { kind: 'script', script: 'start:dashboard' };
  const indexPath = path.join(repoRoot, 'dashboard', 'dist', 'index.html');
  return existsSync(indexPath) ? { kind: 'script', script: 'start:dashboard:stable' } : { kind: 'missing_build', indexPath };
}
