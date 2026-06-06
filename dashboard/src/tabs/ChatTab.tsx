import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  formatDate,
  formatNumber,
  formatPercent,
  getMessageTokenCount,
  getReplayDisplayTokenCount,
} from '../lib/format';
import {
  buildDisplayedSystemPromptContent,
  buildFallbackPromptContext,
  buildLiveMessageScrollSignature,
  estimatePromptTokens,
} from '../lib/chatMessages';
import { resolveContextBarVisual } from '../lib/contextBar';
import { getToolRunningLabel } from '../lib/tool-status';
import { useChatScroll } from '../hooks/useChatScroll';
import { groupMessagesIntoTurns, normalizeMessageKind, type ChatTurn } from '../lib/chatTurns';
import type {
  ChatSession,
  ContextUsage,
  DashboardPreset,
  DashboardPresetExecutionFamily,
  RepoSearchAutoAppendPreview,
  RepoSearchAutoAppendSelection,
} from '../types';
import type { ChatMessage } from '../types';

const GROUNDING_STATUS_LABELS: Record<'ungrounded' | 'snippet_only' | 'fetched', string> = {
  ungrounded: 'No web evidence',
  snippet_only: 'Search snippet only',
  fetched: 'Fetched evidence',
};

function getGroundingStatusLabel(status: ChatMessage['groundingStatus']): string | null {
  if (status === 'ungrounded' || status === 'snippet_only' || status === 'fetched') {
    return GROUNDING_STATUS_LABELS[status];
  }
  return null;
}

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
  webSearchEnabled: boolean;
  showSettings: boolean;
  planRepoRootInput: string;
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  repoSearchAutoAppendPreview?: RepoSearchAutoAppendPreview | null;
  repoSearchAutoAppendSelection?: RepoSearchAutoAppendSelection;
  isRepoSearchAutoAppendPreviewLoading?: boolean;
  liveMessages: ChatMessage[];
  chatInput: string;
  chatBusy: boolean;
  chatError: string | null;
  onSelectSession(sessionId: string): void;
  onToggleSettings(): void;
  onChangePlanRepoRoot(value: string): void;
  onChangeChatInput(value: string): void;
  onSetRepoSearchAutoAppendSelection?(selection: RepoSearchAutoAppendSelection): void;
  onCreateSession(): Promise<void>;
  onDeleteSession(): Promise<void>;
  onUpdateSessionPreset(presetId: string): Promise<void>;
  onToggleThinking(enabled: boolean): Promise<void>;
  onToggleWebSearchEnabled(enabled: boolean): Promise<void>;
  onSavePlanRepoRoot(): Promise<void>;
  onClearToolContext(): Promise<void>;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
  onCondense(): Promise<void>;
  onSendPlan(): Promise<void>;
  onSendRepoSearch(): Promise<void>;
  onSendMessage(): Promise<void>;
};

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
  webSearchEnabled,
  showSettings,
  planRepoRootInput,
  contextUsage,
  liveToolPromptTokenCount,
  repoSearchAutoAppendPreview = null,
  repoSearchAutoAppendSelection = { includeAgentsMd: true, includeRepoFileListing: true },
  isRepoSearchAutoAppendPreviewLoading = false,
  liveMessages,
  chatInput,
  chatBusy,
  chatError,
  onSelectSession,
  onToggleSettings,
  onChangePlanRepoRoot,
  onChangeChatInput,
  onSetRepoSearchAutoAppendSelection = () => {},
  onCreateSession,
  onDeleteSession,
  onUpdateSessionPreset,
  onToggleThinking,
  onToggleWebSearchEnabled,
  onSavePlanRepoRoot,
  onClearToolContext,
  onDeleteMessage,
  onDeleteTurn,
  onCondense,
  onSendPlan,
  onSendRepoSearch,
  onSendMessage,
}: ChatTabProps) {
  const persistedMessages = selectedSession ? selectedSession.messages : [];
  const visibleMessages = [...persistedMessages, ...liveMessages];
  const showRepoSearchAutoAppendControls = chatMode === 'repo-search'
    && persistedMessages.length === 0
    && liveMessages.length === 0;
  const promptContext = selectedSession
    ? selectedSession.promptContext || buildFallbackPromptContext(selectedSession, selectedChatPreset, isRepoToolMode, planRepoRootInput)
    : null;
  const displayedSystemPromptContent = promptContext
    ? buildDisplayedSystemPromptContent(promptContext.content, showRepoSearchAutoAppendControls, repoSearchAutoAppendSelection)
    : '';
  const visibleMessageIds = visibleMessages.map((message) => message.id).join('|');
  const liveMessageScrollSignature = buildLiveMessageScrollSignature(liveMessages);
  const { chatLogRef } = useChatScroll(visibleMessageIds, liveMessageScrollSignature);
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
            {selectedSession.condensedSummary && (
              <details className="detail-card">
                <summary>Condensed Summary</summary>
                <pre>{selectedSession.condensedSummary}</pre>
              </details>
            )}
            <div className="chat-log" ref={chatLogRef}>
              {promptContext && displayedSystemPromptContent.trim() ? (
                <article className="msg system system_context">
                  <header className="msg-header">
                    <span>system | first message</span>
                    <span className="msg-meta">
                      <span className="msg-tokens">
                        {formatNumber(estimatePromptTokens(displayedSystemPromptContent))} tokens
                      </span>
                    </span>
                  </header>
                  <details className="system-context-bubble">
                    <summary>{promptContext.label}</summary>
                    <pre>{displayedSystemPromptContent}</pre>
                  </details>
                </article>
              ) : null}
              {groupMessagesIntoTurns(visibleMessages, new Set(liveMessages.map((message) => message.id))).map((turn) => {
                if (turn.steps.length === 0) {
                  const message = turn.main;
                  if (!message) return null;
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isLive={turn.isLive}
                      isDirectChatMode={isDirectChatMode}
                      chatBusy={chatBusy}
                      onDeleteMessage={onDeleteMessage}
                    />
                  );
                }
                return (
                  <ChatTurnBubble
                    key={turn.key}
                    turn={turn}
                    isDirectChatMode={isDirectChatMode}
                    chatBusy={chatBusy}
                    onDeleteMessage={onDeleteMessage}
                    onDeleteTurn={onDeleteTurn}
                  />
                );
              })}
            </div>
            <div className="composer">
              {showSettings ? (
                <SettingsPopover
                  contextUsage={contextUsage}
                  liveToolPromptTokenCount={liveToolPromptTokenCount}
                  isRepoToolMode={isRepoToolMode}
                  chatBusy={chatBusy}
                  onClearToolContext={onClearToolContext}
                  onCondense={onCondense}
                />
              ) : null}
              {showRepoSearchAutoAppendControls ? (
                <div className="repo-auto-append-row" aria-label="Repo-search auto-append controls">
                  <RepoAutoAppendButton
                    label="AGENTS.md"
                    icon="A"
                    enabled={repoSearchAutoAppendSelection.includeAgentsMd}
                    loading={isRepoSearchAutoAppendPreviewLoading}
                    available={repoSearchAutoAppendPreview?.agentsMd.available ?? false}
                    tokenCount={repoSearchAutoAppendPreview?.agentsMd.tokenCount ?? null}
                    tokenSource={repoSearchAutoAppendPreview?.agentsMd.tokenSource ?? 'estimate'}
                    enableTitle="Enable AGENTS.md auto-append for the first repo-search message"
                    disableTitle="Disable AGENTS.md auto-append for the first repo-search message"
                    onToggle={() => onSetRepoSearchAutoAppendSelection({
                      ...repoSearchAutoAppendSelection,
                      includeAgentsMd: !repoSearchAutoAppendSelection.includeAgentsMd,
                    })}
                  />
                  <RepoAutoAppendButton
                    label="File scan"
                    icon="F"
                    enabled={repoSearchAutoAppendSelection.includeRepoFileListing}
                    loading={isRepoSearchAutoAppendPreviewLoading}
                    available={repoSearchAutoAppendPreview?.repoFileListing.available ?? false}
                    tokenCount={repoSearchAutoAppendPreview?.repoFileListing.tokenCount ?? null}
                    tokenSource={repoSearchAutoAppendPreview?.repoFileListing.tokenSource ?? 'estimate'}
                    enableTitle="Enable file scan auto-append for the first repo-search message"
                    disableTitle="Disable file scan auto-append for the first repo-search message"
                    onToggle={() => onSetRepoSearchAutoAppendSelection({
                      ...repoSearchAutoAppendSelection,
                      includeRepoFileListing: !repoSearchAutoAppendSelection.includeRepoFileListing,
                    })}
                  />
                  <RepoAutoAppendButton
                    label="Web"
                    icon="W"
                    enabled={webSearchEnabled}
                    loading={false}
                    available
                    tokenCount={null}
                    tokenSource="estimate"
                    enableTitle="Enable web search for this session"
                    disableTitle="Disable web search for this session"
                    onToggle={() => { void onToggleWebSearchEnabled(!webSearchEnabled); }}
                  />
                </div>
              ) : null}
              <textarea
                placeholder={chatMode === 'plan' ? 'Describe the feature to plan (plan mode runs repo-search)...' : chatMode === 'repo-search' ? 'Enter a repo search query...' : chatMode === 'summary' ? 'Enter a summary request...' : 'Send a local chat message...'}
                value={chatInput}
                onChange={(event) => onChangeChatInput(event.target.value)}
                rows={4}
              />
              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  <button
                    type="button"
                    className={showSettings ? 'composer-pill settings-toggle active' : 'composer-pill settings-toggle'}
                    onClick={onToggleSettings}
                    title="Toggle settings"
                    aria-label="Toggle settings"
                  >
                    &#9881;
                  </button>
                  {isDirectChatMode ? (
                    <button
                      type="button"
                      className={isThinkingEnabledForCurrentSession ? 'composer-pill thinking-toggle active' : 'composer-pill thinking-toggle'}
                      onClick={() => { void onToggleThinking(!isThinkingEnabledForCurrentSession); }}
                      disabled={chatBusy}
                      title={isThinkingEnabledForCurrentSession ? 'Disable thinking for this session' : 'Enable thinking for this session'}
                    >
                      <span aria-hidden="true">&#128173;</span>
                      <span>Thinking</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`composer-pill web-toggle ${webSearchEnabled ? 'active' : ''}`}
                    onClick={() => { void onToggleWebSearchEnabled(!webSearchEnabled); }}
                    disabled={chatBusy}
                    title={webSearchEnabled ? 'Disable web search for this chat' : 'Enable web search for this chat'}
                  >
                    <span aria-hidden="true">W</span>
                    <span>Web</span>
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
                  {isRepoToolMode ? (
                    <>
                      <input
                        className="composer-plan-root"
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
                        Directory
                      </button>
                    </>
                  ) : null}
                </div>
                <div className="composer-toolbar-context">
                  <ContextBar
                    usage={contextUsage}
                    sessionContextWindowTokens={selectedSession.contextWindowTokens}
                    liveToolPromptTokenCount={liveToolPromptTokenCount}
                    chatBusy={chatBusy}
                  />
                </div>
                <div className="composer-toolbar-right">
                  <button
                    type="button"
                    className="composer-send"
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
              </div>
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

function ContextBar({ usage, sessionContextWindowTokens, liveToolPromptTokenCount, chatBusy }: {
  usage: ContextUsage | null;
  sessionContextWindowTokens: number;
  liveToolPromptTokenCount: number | null;
  chatBusy: boolean;
}) {
  const visual = resolveContextBarVisual(usage, sessionContextWindowTokens, liveToolPromptTokenCount, chatBusy);
  if (!visual) return null;
  return (
    <div className="context-bar" title={visual.titleText} aria-label={visual.titleText}>
      {visual.sections.map((section) => (
        <div
          key={section.kind}
          className={`context-bar-section ${section.kind}`}
          style={{ width: `${section.percent}%`, background: section.kind === 'used' ? visual.fillColor : undefined }}
          tabIndex={section.kind === 'provider-overhead' || section.kind === 'warn' ? 0 : -1}
          aria-label={section.titleText}
        >
          {section.kind === 'provider-overhead' || section.kind === 'warn' ? (
            <span className="context-bar-tooltip" role="tooltip">{section.titleText}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SettingsPopover(props: {
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  isRepoToolMode: boolean;
  chatBusy: boolean;
  onClearToolContext(): Promise<void>;
  onCondense(): Promise<void>;
}) {
  const { contextUsage, liveToolPromptTokenCount, isRepoToolMode, chatBusy, onClearToolContext, onCondense } = props;
  if (!contextUsage) return null;
  return (
    <div className={contextUsage.shouldCondense ? 'composer-settings-popover usage warning' : 'composer-settings-popover usage'}>
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
  );
}

function RepoAutoAppendButton(props: {
  label: string;
  icon: string;
  enabled: boolean;
  loading: boolean;
  available: boolean;
  tokenCount: number | null;
  tokenSource: 'llama.cpp' | 'estimate';
  enableTitle: string;
  disableTitle: string;
  onToggle(): void;
}) {
  const tokenLabel = props.loading
    ? 'loading'
    : props.available && typeof props.tokenCount === 'number'
      ? `${formatNumber(props.tokenCount)} tokens`
      : 'not found';
  const title = props.enabled ? props.disableTitle : props.enableTitle;
  return (
    <button
      type="button"
      className={props.enabled ? 'repo-auto-append-button on' : 'repo-auto-append-button off'}
      onClick={props.onToggle}
      aria-label={`${props.enabled ? 'Disable' : 'Enable'} ${props.label === 'File scan' ? 'file scan' : props.label} auto-append`}
      title={`${title}. ${props.label}: ${tokenLabel}${props.available ? ` (${props.tokenSource})` : ''}.`}
    >
      <span className="repo-auto-append-icon" aria-hidden="true">{props.icon}</span>
      <span className="repo-auto-append-copy">
        <strong>{props.label}</strong>
        <span>{tokenLabel}</span>
      </span>
      <span className="repo-auto-append-state" aria-hidden="true">{props.enabled ? 'On' : 'Off'}</span>
    </button>
  );
}

function MessageHeader({ message, isLive, chatBusy, onDeleteMessage }: {
  message: ChatMessage;
  isLive: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
}) {
  const messageKind = normalizeMessageKind(message);
  const messageLabel = messageKind === 'assistant_thinking'
    ? 'assistant thinking'
    : messageKind === 'assistant_tool_call'
      ? 'assistant tool'
      : message.role;
  return (
    <header className="msg-header">
      <span>{messageLabel} | {isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        <span className="msg-tokens">{formatNumber(getReplayDisplayTokenCount(message))} tokens</span>
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
  );
}

function renderMessageBody(message: ChatMessage, isDirectChatMode: boolean) {
  const messageKind = normalizeMessageKind(message);
  const toolCommand = typeof message.toolCallCommand === 'string' ? message.toolCallCommand.trim() : '';
  const toolOutput = message.toolCallOutput || message.toolCallOutputSnippet || '';
  const groundingStatusLabel = messageKind === 'assistant_answer'
    ? getGroundingStatusLabel(message.groundingStatus)
    : null;
  return (
    <>
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
          <code>{toolCommand}</code>
          {message.toolCallStatus === 'running' ? <span className="tool-spinner"> {getToolRunningLabel(toolCommand)}</span> : null}
          {toolOutput ? (
            <details className="tool-result">
              <summary aria-label="Show tool result" title="Show tool result">+ result</summary>
              <pre>{toolOutput}</pre>
            </details>
          ) : null}
        </div>
      ) : message.role === 'assistant' ? (
        <div className="markdown-body">
          {groundingStatusLabel ? (
            <span className="chat-grounding-badge">{groundingStatusLabel}</span>
          ) : null}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="user-message">{message.content}</p>
      )}
    </>
  );
}

function MessageBubble({ message, isLive, isDirectChatMode, chatBusy, onDeleteMessage, extraClass }: {
  message: ChatMessage;
  isLive: boolean;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  extraClass?: string;
}) {
  const messageKind = normalizeMessageKind(message);
  return (
    <article className={`msg ${message.role} ${messageKind}${extraClass ? ` ${extraClass}` : ''}${isLive ? ' live' : ''}`}>
      <MessageHeader message={message} isLive={isLive} chatBusy={chatBusy} onDeleteMessage={onDeleteMessage} />
      {renderMessageBody(message, isDirectChatMode)}
    </article>
  );
}

function ChatTurnBubble({ turn, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteTurn }: {
  turn: ChatTurn;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  const visibleTokens = turn.main ? getReplayDisplayTokenCount(turn.main) : 0;
  const aggregateTokens = turn.messages.reduce((sum, message) => sum + getMessageTokenCount(message), 0);
  const headerTimestamp = turn.main ? turn.main.createdAtUtc : turn.messages[0]?.createdAtUtc ?? null;
  return (
    <article className={`msg assistant turn${turn.isLive ? ' live' : ''}`}>
      <header className="msg-header">
        <span>assistant turn | {turn.isLive ? 'live' : formatDate(headerTimestamp)}</span>
        <span className="msg-meta">
          <span className="msg-tokens" title={`${formatNumber(aggregateTokens)} internal run tokens`}>
            {formatNumber(visibleTokens)} context tokens
          </span>
          {!turn.isLive ? (
            <button
              type="button"
              className="msg-icon-button danger"
              onClick={() => { void onDeleteTurn(turn.messages.map((message) => message.id)); }}
              disabled={chatBusy}
              aria-label="Delete turn"
              title="Delete entire turn"
            >
              &#128465;
            </button>
          ) : null}
        </span>
      </header>
      <details className="internal-logic">
        <summary>Internal Logic ({turn.steps.length})</summary>
        <div className="internal-logic-steps">
          {turn.steps.map((step) => (
            <MessageBubble
              key={step.id}
              message={step}
              isLive={turn.isLive}
              isDirectChatMode={isDirectChatMode}
              chatBusy={chatBusy}
              onDeleteMessage={onDeleteMessage}
            />
          ))}
        </div>
      </details>
      {turn.main ? (
        <MessageBubble
          message={turn.main}
          isLive={turn.isLive}
          isDirectChatMode={isDirectChatMode}
          chatBusy={chatBusy}
          onDeleteMessage={onDeleteMessage}
          extraClass="turn-main"
        />
      ) : null}
    </article>
  );
}
