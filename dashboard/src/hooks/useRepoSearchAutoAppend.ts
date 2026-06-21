import { useEffect, useState } from 'react';

import { toError } from '../../../src/lib/errors.js';
import { getRepoSearchAutoAppendPreview } from '../api';
import { buildRepoSearchAutoAppendSelection } from '../lib/repo-append-controls';
import type {
  ChatMessage,
  ChatSession,
  DashboardPresetExecutionFamily,
  RepoSearchAutoAppendPreview,
  RepoSearchAutoAppendSelection,
} from '../types';

export type UseRepoSearchAutoAppendResult = {
  preview: RepoSearchAutoAppendPreview | null;
  selection: RepoSearchAutoAppendSelection;
  previewLoading: boolean;
  setSelection(value: RepoSearchAutoAppendSelection): void;
};

export function shouldFetchAutoAppendPreview(
  selectedSession: ChatSession | null,
  chatMode: DashboardPresetExecutionFamily,
  liveMessages: ChatMessage[],
): boolean {
  if (chatMode !== 'repo-search') {
    return false;
  }
  if (!selectedSession) {
    return false;
  }
  if (selectedSession.messages.length > 0) {
    return false;
  }
  return liveMessages.length === 0;
}

export function useRepoSearchAutoAppend(deps: {
  selectedSession: ChatSession | null;
  chatMode: DashboardPresetExecutionFamily;
  planRepoRootInput: string;
  liveMessages: ChatMessage[];
  onError(error: Error): void;
}): UseRepoSearchAutoAppendResult {
  const [preview, setPreview] = useState<RepoSearchAutoAppendPreview | null>(null);
  const [selection, setSelection] = useState<RepoSearchAutoAppendSelection>({
    includeAgentsMd: true,
    includeRepoFileListing: true,
  });
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);

  const sessionId = deps.selectedSession?.id ?? '';
  const messagesLength = deps.selectedSession?.messages.length ?? 0;
  const planRepoRoot = deps.selectedSession?.planRepoRoot ?? '';
  const liveLength = deps.liveMessages.length;

  useEffect(() => {
    if (!sessionId || !shouldFetchAutoAppendPreview(deps.selectedSession, deps.chatMode, deps.liveMessages)) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    getRepoSearchAutoAppendPreview(sessionId, {
      repoRoot: deps.planRepoRootInput.trim() || planRepoRoot || '',
    }).then((next) => {
      if (cancelled) {
        return;
      }
      setPreview(next);
      setSelection(buildRepoSearchAutoAppendSelection({
        includeAgentsMd: next.agentsMd.enabledDefault,
        includeRepoFileListing: next.repoFileListing.enabledDefault,
      }));
    }).catch((error) => {
      if (!cancelled) {
        deps.onError(toError(error));
      }
    }).finally(() => {
      if (!cancelled) {
        setPreviewLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deps.chatMode, sessionId, messagesLength, planRepoRoot, deps.planRepoRootInput, liveLength]);

  return {
    preview,
    selection,
    previewLoading,
    setSelection,
  };
}
