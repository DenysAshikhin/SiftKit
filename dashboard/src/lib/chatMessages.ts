import type {
  ChatMessage,
  ChatPromptContext,
  ChatSession,
  DashboardPreset,
} from '../types';

export function compareMessageCreatedAt(left: ChatMessage, right: ChatMessage): number {
  const leftTime = Date.parse(left.createdAtUtc || '');
  const rightTime = Date.parse(right.createdAtUtc || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return 0;
}

export function hashFnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

export function buildLiveMessageScrollSignature(messages: ChatMessage[]): string {
  return messages.map((message) => [
    message.id,
    message.kind || '',
    hashFnv1a32(message.content || ''),
    hashFnv1a32(message.toolCallCommand || ''),
    hashFnv1a32(message.toolCallOutputSnippet || ''),
    hashFnv1a32(message.toolCallOutput || ''),
    message.toolCallStatus || '',
    message.toolCallExitCode ?? '',
  ].join(':')).join('|');
}

export function buildFallbackPromptContext(
  selectedSession: ChatSession,
  selectedChatPreset: DashboardPreset | null,
  isRepoToolMode: boolean,
  planRepoRootInput: string,
): ChatPromptContext {
  const promptPrefix = selectedChatPreset?.promptPrefix?.trim() || 'general, coder friendly assistant';
  const toolNames = Array.isArray(selectedChatPreset?.allowedTools) ? selectedChatPreset.allowedTools : [];
  const parts = [
    '## System prompt',
    '',
    promptPrefix,
  ];
  if (isRepoToolMode) {
    parts.push(
      '',
      '## Tool schema',
      '',
      JSON.stringify({
        mode: selectedChatPreset?.presetKind || selectedSession.mode || 'repo-search',
        repoRoot: planRepoRootInput || selectedSession.planRepoRoot || '',
        allowedTools: toolNames,
        includeAgentsMd: selectedChatPreset?.includeAgentsMd !== false,
        includeRepoFileListing: selectedChatPreset?.includeRepoFileListing !== false,
      }, null, 2),
    );
  }
  return {
    id: `${selectedSession.id}:system-context-fallback`,
    role: 'system',
    kind: 'system_context',
    label: isRepoToolMode ? 'System prompt and tool schema' : 'System prompt',
    content: parts.join('\n'),
    createdAtUtc: selectedSession.createdAtUtc,
    deletable: false,
  };
}
