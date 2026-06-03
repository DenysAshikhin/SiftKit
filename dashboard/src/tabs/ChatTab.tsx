import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  formatDate,
  formatNumber,
  formatPercent,
  getMessageTokenCount,
  isMessageTokenEstimateFallback,
} from '../lib/format';
import type { ChatPromptContext, ChatSession, ContextUsage, DashboardPreset, DashboardPresetExecutionFamily } from '../types';
import type { ChatMessage } from '../types';

type SessionPromptCacheStats = {
  cacheHitRate: number | null;
  promptCacheTokens: number;
  promptEvalTokens: number;
  acceptanceRate: number | null;
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
};

type ChatTabProps = {
  sessions: ChatSession[];
  selectedSessionId: string;
  selectedSession: ChatSession | null;
  sessionPromptCacheStats: SessionPromptCacheStats;
  webPresets: DashboardPreset[];
  selectedChatPreset: DashboardPreset | null;
  chatMode: DashboardPresetExecutionFamily;
  isDirectChatMode: boolean;
  isRepoToolMode: boolean;
  isThinkingEnabledForCurrentSession: boolean;
  showSettings: boolean;
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  liveMessages: ChatMessage[];
  chatInput: string;
  chatBusy: boolean;
  chatError: string | null;
  onSelectSession(sessionId: string): void;
  onToggleSettings(): void;
  onChangePlanRepoRoot(value: string): void;
  onChangePlanMaxTurns(value: string): void;
  onChangeChatInput(value: string): void;
  onCreateSession(): Promise<void>;
  onDeleteSession(): Promise<void>;
  onUpdateSessionPreset(presetId: string): Promise<void>;
  onToggleThinking(enabled: boolean): Promise<void>;
  onSavePlanRepoRoot(): Promise<void>;
  onClearToolContext(): Promise<void>;
  onDeleteMessage(messageId: string): Promise<void>;
  onCondense(): Promise<void>;
  onSendPlan(): Promise<void>;
  onSendRepoSearch(): Promise<void>;
  onSendMessage(): Promise<void>;
};

function compareMessageCreatedAt(left: ChatMessage, right: ChatMessage): number {
  const leftTime = Date.parse(left.createdAtUtc || '');
  const rightTime = Date.parse(right.createdAtUtc || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return 0;
}

function buildFallbackPromptContext(
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

export function ChatTab({
  sessions,
  selectedSessionId,
  selectedSession,
  sessionPromptCacheStats,
  webPresets,
  selectedChatPreset,
  chatMode,
  isDirectChatMode,
  isRepoToolMode,
  isThinkingEnabledForCurrentSession,
  showSettings,
  planRepoRootInput,
  planMaxTurnsInput,
  contextUsage,
  liveToolPromptTokenCount,
  liveMessages,
  chatInput,
  chatBusy,
  chatError,
  onSelectSession,
  onToggleSettings,
  onChangePlanRepoRoot,
  onChangePlanMaxTurns,
  onChangeChatInput,
  onCreateSession,
  onDeleteSession,
  onUpdateSessionPreset,
  onToggleThinking,
  onSavePlanRepoRoot,
  onClearToolContext,
  onDeleteMessage,
  onCondense,
  onSendPlan,
  onSendRepoSearch,
  onSendMessage,
}: ChatTabProps) {
  const persistedMessages = selectedSession ? [...selectedSession.messages].sort(compareMessageCreatedAt) : [];
  const visibleMessages = [...persistedMessages, ...liveMessages];
  const promptContext = selectedSession
    ? selectedSession.promptContext || buildFallbackPromptContext(selectedSession, selectedChatPreset, isRepoToolMode, planRepoRootInput)
    : null;
  const chatLogRef = React.useRef<HTMLDivElement | null>(null);
  const visibleMessageIds = visibleMessages.map((message) => message.id).join('|');
  React.useEffect(() => {
    if (!chatLogRef.current) {
      return;
    }
    chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [visibleMessageIds]);
  return (
    <section className="panel-grid chat-layout">
      <section className="panel">
        <div className="chat-header">
          <h2>Sessions</h2>
          <div className="chat-actions">
            <button onClick={() => { void onCreateSession(); }} disabled={chatBusy}>New</button>
            <button onClick={() => { void onDeleteSession(); }} disabled={chatBusy || !selectedSessionId}>Delete</button>
          </div>
        </div>
        <ul className="run-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button className={selectedSessionId === session.id ? 'selected' : ''} onClick={() => onSelectSession(session.id)}>
                <span>{session.title}</span>
                <span>{formatDate(session.updatedAtUtc)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        {selectedSession ? (
          <>
            <div className="session-header-row">
              <h2>{selectedSession.title}</h2>
              <span className="hint">
                Cache: {formatPercent(sessionPromptCacheStats.cacheHitRate)}
                {' | '}
                Acceptance: {formatPercent(sessionPromptCacheStats.acceptanceRate)}
                {' | '}
                Prompt/s: {formatNumber(sessionPromptCacheStats.promptTokensPerSecond)}
                {' | '}
                Generation/s: {formatNumber(sessionPromptCacheStats.generationTokensPerSecond)}
                {' | '}
                {formatNumber(sessionPromptCacheStats.promptCacheTokens)} cached
                {' | '}
                {formatNumber(sessionPromptCacheStats.promptEvalTokens)} eval
              </span>
            </div>
            <div className="chat-mode-row">
              <button
                type="button"
                className={showSettings ? 'active settings-toggle' : 'settings-toggle'}
                onClick={onToggleSettings}
                title="Toggle settings"
              >
                &#9881;
              </button>
              <select
                value={selectedChatPreset?.id || ''}
                onChange={(event) => { void onUpdateSessionPreset(event.target.value); }}
                disabled={chatBusy || webPresets.length === 0}
              >
                {webPresets.length === 0 ? <option value="">No presets</option> : null}
                {webPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              {selectedChatPreset ? (
                <span className="hint settings-summary" title={selectedChatPreset.description}>
                  {selectedChatPreset.presetKind} | {selectedChatPreset.operationMode}
                </span>
              ) : null}
              {isRepoToolMode && !showSettings && (
                <span className="hint settings-summary" title="Click the gear icon to adjust">
                  {planMaxTurnsInput ? `${planMaxTurnsInput} turns` : ''}
                </span>
              )}
            </div>
            {showSettings && (
              <>
                {isDirectChatMode ? (
                  <div className="thinking-toggle-row">
                    <label htmlFor="thinking-toggle">Thinking</label>
                    <input
                      id="thinking-toggle"
                      type="checkbox"
                      checked={selectedSession.thinkingEnabled !== false}
                      onChange={(event) => { void onToggleThinking(event.target.checked); }}
                      disabled={chatBusy}
                    />
                  </div>
                ) : null}
                {isRepoToolMode ? (
                  <div className="plan-root-row">
                    <input
                      placeholder="Repo folder path..."
                      value={planRepoRootInput}
                      onChange={(event) => onChangePlanRepoRoot(event.target.value)}
                      disabled={chatBusy}
                    />
                    <button
                      type="button"
                      onClick={() => { void onSavePlanRepoRoot(); }}
                      disabled={chatBusy || !planRepoRootInput.trim()}
                    >
                      Save Folder
                    </button>
                  </div>
                ) : null}
                {isRepoToolMode ? (
                  <div className="settings-inline-row">
                    <label htmlFor="max-turns-input" title="Maximum number of tool calls before stopping">Max Turns</label>
                    <input
                      id="max-turns-input"
                      type="number"
                      min="1"
                      max="200"
                      style={{ width: '70px' }}
                      value={planMaxTurnsInput}
                      onChange={(event) => onChangePlanMaxTurns(event.target.value)}
                      disabled={chatBusy}
                    />
                  </div>
                ) : null}
                {contextUsage && (
                  <div className={contextUsage.shouldCondense ? 'usage warning' : 'usage'}>
                    <strong>
                      <span title="Replayable chat context tokens in this session, excluding hidden tool-call context.">
                        Context: {formatNumber(contextUsage.chatUsedTokens)} / {formatNumber(contextUsage.contextWindowTokens)} tokens
                      </span>
                    </strong>
                    <span title="Format: chat_tokens (total_tokens_including_hidden_tool_context).">
                      Remaining: {formatNumber(contextUsage.remainingTokens)}
                      {' | '}
                      {formatNumber(contextUsage.chatUsedTokens)} ({formatNumber(contextUsage.totalUsedTokens)} with tools)
                      {' | '}
                      Warn at: {formatNumber(contextUsage.warnThresholdTokens)}
                    </span>
                    <span title="Tokens from preserved assistant thinking/reasoning text that can be replayed into the next request.">
                      Thinking/reasoning: {formatNumber(contextUsage.thinkingUsedTokens || 0)}
                    </span>
                    {isRepoToolMode && Number.isFinite(liveToolPromptTokenCount) ? (
                      <span title="Latest backend prompt_tokens for an active plan/repo-search tool step.">
                        Live Step Prompt Tokens (backend): {formatNumber(liveToolPromptTokenCount)}
                      </span>
                    ) : null}
                    {Number(contextUsage.estimatedTokenFallbackTokens || 0) > 0 ? (
                      <span title="These session totals include local fallback estimates where backend usage was unavailable.">
                        Estimated Fallback: {formatNumber(Number(contextUsage.estimatedTokenFallbackTokens || 0))} tokens
                      </span>
                    ) : null}
                    <div className="usage-actions">
                      <button
                        onClick={() => { void onClearToolContext(); }}
                        disabled={chatBusy || Number(contextUsage.toolUsedTokens || 0) <= 0}
                      >
                        Discard Tool Context
                      </button>
                    </div>
                    {contextUsage.shouldCondense && (
                      <button onClick={() => { void onCondense(); }} disabled={chatBusy}>Condense Now</button>
                    )}
                  </div>
                )}
              </>
            )}
            {selectedSession.condensedSummary && (
              <details className="detail-card">
                <summary>Condensed Summary</summary>
                <pre>{selectedSession.condensedSummary}</pre>
              </details>
            )}
            <div className="chat-log" ref={chatLogRef}>
              {promptContext && promptContext.content.trim() ? (
                <article className="msg system system_context">
                  <header className="msg-header">
                    <span>system | first message</span>
                    <span className="msg-meta">
                      <span className="msg-tokens">
                        {formatNumber(Math.max(1, Math.ceil(promptContext.content.length / 4)))} est.
                      </span>
                    </span>
                  </header>
                  <details className="system-context-bubble">
                    <summary>{promptContext.label}</summary>
                    <pre>{promptContext.content}</pre>
                  </details>
                </article>
              ) : null}
              {visibleMessages.map((message) => {
                const isLive = liveMessages.some((liveMessage) => liveMessage.id === message.id);
                const messageKind = message.kind || (message.role === 'user' ? 'user_text' : 'assistant_answer');
                const messageLabel = messageKind === 'assistant_thinking'
                  ? 'assistant thinking'
                  : messageKind === 'assistant_tool_call'
                    ? 'assistant tool'
                    : message.role;
                const toolOutput = message.toolCallOutput || message.toolCallOutputSnippet || '';
                return (
                <article key={message.id} className={`msg ${message.role} ${messageKind}${isLive ? ' live' : ''}`}>
                  <header className="msg-header">
                    <span>{messageLabel} | {isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
                    <span className="msg-meta">
                      <span
                        className="msg-tokens"
                        title="Format: tokens_for_message (associated hidden tool-call tokens)."
                      >
                        {formatNumber(getMessageTokenCount(message))}
                        {isMessageTokenEstimateFallback(message) ? ' est.' : ''}
                        {' '}
                        ({formatNumber(Number(message.associatedToolTokens || 0))})
                      </span>
                      {!isLive ? (
                        <button
                          type="button"
                          className="msg-icon-button danger"
                          onClick={() => { void onDeleteMessage(message.id); }}
                          disabled={chatBusy}
                          aria-label="Delete message"
                          title="Delete message"
                        >
                          &#128465;
                        </button>
                      ) : null}
                    </span>
                  </header>
                  {isDirectChatMode && message.role === 'assistant' && message.thinkingContent ? (
                    <details className="thinking-box">
                      <summary>Thinking</summary>
                      <pre>{message.thinkingContent}</pre>
                    </details>
                  ) : null}
                  {messageKind === 'assistant_thinking' ? (
                    <pre className="thinking-message">{message.content}</pre>
                  ) : messageKind === 'assistant_tool_call' ? (
                    <div className="tool-message">
                      <code>{message.toolCallCommand || message.content}</code>
                      {message.toolCallStatus === 'running' ? <span className="tool-spinner"> ...</span> : null}
                      {typeof message.toolCallExitCode === 'number' ? (
                        <span className={message.toolCallExitCode === 0 ? 'exit-ok' : 'exit-fail'}>
                          {' '}exit {message.toolCallExitCode}
                        </span>
                      ) : null}
                      {typeof message.toolCallPromptTokenCount === 'number' ? (
                        <span className="hint"> prompt {formatNumber(message.toolCallPromptTokenCount)}</span>
                      ) : null}
                      {toolOutput ? (
                        <details className="tool-result">
                          <summary aria-label="Show tool result" title="Show tool result">+ result</summary>
                          <pre>{toolOutput}</pre>
                        </details>
                      ) : null}
                    </div>
                  ) : message.role === 'assistant' ? (
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="user-message">{message.content}</p>
                  )}
                </article>
                );
              })}
            </div>
            <div className="composer">
              <textarea
                placeholder={chatMode === 'plan' ? 'Describe the feature to plan (plan mode runs repo-search)...' : chatMode === 'repo-search' ? 'Enter a repo search query...' : chatMode === 'summary' ? 'Enter a summary request...' : 'Send a local chat message...'}
                value={chatInput}
                onChange={(event) => onChangeChatInput(event.target.value)}
                rows={4}
              />
              <button
                onClick={() => {
                  if (chatMode === 'plan') {
                    void onSendPlan();
                    return;
                  }
                  if (chatMode === 'repo-search') {
                    void onSendRepoSearch();
                    return;
                  }
                  void onSendMessage();
                }}
                disabled={chatBusy || !chatInput.trim()}
              >
                {chatMode === 'plan' ? 'Generate Plan' : chatMode === 'repo-search' ? 'Search' : chatMode === 'summary' ? 'Summarize' : 'Send'}
              </button>
            </div>
            {chatError && <p className="error">{chatError}</p>}
          </>
        ) : (
          <p className="hint">Create or pick a session.</p>
        )}
      </section>
    </section>
  );
}
