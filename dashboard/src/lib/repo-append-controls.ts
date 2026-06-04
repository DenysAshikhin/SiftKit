import type { RepoSearchAutoAppendSelection } from '../types';

export function buildRepoSearchAutoAppendPayload(selection: RepoSearchAutoAppendSelection): {
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
} {
  return {
    includeAgentsMd: selection.includeAgentsMd,
    includeRepoFileListing: selection.includeRepoFileListing,
  };
}

export function buildRepoSearchAutoAppendSelection(defaults: RepoSearchAutoAppendSelection): RepoSearchAutoAppendSelection {
  return {
    includeAgentsMd: defaults.includeAgentsMd,
    includeRepoFileListing: defaults.includeRepoFileListing,
  };
}
