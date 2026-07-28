import { readFileSync, statSync } from 'node:fs';
import {
  isAbsolute,
  normalize,
  resolve,
} from 'node:path';

import type { SiftPreset } from './presets.js';
import { buildIgnorePolicy } from './repo-search/command-safety.js';
import { readAgentsMd, scanRepoFiles } from './repo-search/prompts.js';

export type PresetSystemContext = {
  content: string;
  warnings: string[];
  hasAgentsMd: boolean;
  hasRepoFileListing: boolean;
  loadedFiles: string[];
};

type PresetSystemContextSources = Pick<
  SiftPreset,
  'includeAgentsMd' | 'includeRepoFileListing' | 'autoloadFiles'
>;

export class PresetSystemContextBuilder {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
  }

  build(preset: PresetSystemContextSources): PresetSystemContext {
    const sections: string[] = [];
    const warnings: string[] = [];
    const loadedFiles: string[] = [];

    const agentsMd = preset.includeAgentsMd ? readAgentsMd(this.repoRoot) : '';
    if (agentsMd) {
      sections.push(`--- AGENTS.md (project-specific instructions) ---\n\n${agentsMd}`);
    }

    const repoFileListing = preset.includeRepoFileListing
      ? scanRepoFiles(this.repoRoot, buildIgnorePolicy(this.repoRoot))
      : '';
    if (repoFileListing) {
      sections.push(`--- Repository file listing (respects ignore policy) ---\n\n${repoFileListing}`);
    }

    for (const configuredPath of preset.autoloadFiles) {
      this.loadConfiguredFile(configuredPath, sections, warnings, loadedFiles);
    }

    return {
      content: sections.join('\n\n'),
      warnings,
      hasAgentsMd: Boolean(agentsMd),
      hasRepoFileListing: Boolean(repoFileListing),
      loadedFiles,
    };
  }

  private loadConfiguredFile(
    configuredPath: string,
    sections: string[],
    warnings: string[],
    loadedFiles: string[],
  ): void {
    const resolvedPath = isAbsolute(configuredPath)
      ? normalize(configuredPath)
      : resolve(this.repoRoot, configuredPath);

    try {
      const fileStat = statSync(resolvedPath);
      if (!fileStat.isFile()) {
        warnings.push(this.buildWarning(configuredPath, 'not a file'));
        return;
      }
      const content = readFileSync(resolvedPath, 'utf8').trim();
      if (!content) {
        warnings.push(this.buildWarning(configuredPath, 'empty'));
        return;
      }
      sections.push(`--- Autoloaded file: ${configuredPath} ---\n\n${content}`);
      loadedFiles.push(configuredPath);
    } catch (error) {
      const reason = error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'does not exist'
        : 'could not be read';
      warnings.push(this.buildWarning(configuredPath, reason));
    }
  }

  private buildWarning(configuredPath: string, reason: string): string {
    return `Autoload file '${configuredPath}' skipped: ${reason}.`;
  }
}
