import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  formatCompactTokenCount,
  formatDate,
  formatNumber,
  formatTokenLabel,
  getMessageKnownTokenCount,
  getMessageTokenCount,
  getReplayDisplayTokenCount,
} from '../lib/format';
import {
  buildDisplayedSystemPromptContent,
  buildFallbackPromptContext,
  buildLiveMessageScrollSignature,
} from '../lib/chatMessages';
import { getContextBarFillTone } from '../lib/context-bar-tone';
import { deriveSessionIndicator, type SessionIndicator } from '../lib/chat-session-state';
import { ToolCallCard } from '../components/ToolCallCard';
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

type TurnTokenDisplay = {
  tokenCount: number | null;
  exact: boolean;
};

function getTurnTokenDisplay(messages: ChatMessage[]): TurnTokenDisplay {
  let total = 0;
  let knownTotal = 0;
  let hasUnavailableComponent = false;
  for (const message of messages) {
    const tokenCount = getMessageTokenCount(message);
    if (tokenCount === null) {
      hasUnavailableComponent = true;
      knownTotal += getMessageKnownTokenCount(message);
    } else {
      total += tokenCount;
      knownTotal += tokenCount;
    }
  }
  if (!hasUnavailableComponent) {
    return { tokenCount: total, exact: true };
  }
  return knownTotal > 0 ? { tokenCount: knownTotal, exact: false } : { tokenCount: null, exact: false };
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

export type ChatTabProps = {
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
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
  onCondense(): Promise<void>;
  onSendPlan(): Promise<void>;
  onSendRepoSearch(): Promise<void>;
  onSendMessage(): Promise<void>;
};

const SESSION_INDICATOR_LABELS: Record<SessionIndicator, string> = {
  streaming: 'streaming',
  tool: 'tool running',
  failed: 'failed',
  completed: 'idle',
};

function SessionIndicatorMark({ indicator }: { indicator: SessionIndicator }) {
  if (indicator === 'streaming') {
    return <span className="typing"><i /><i /><i /></span>;
  }
  if (indicator === 'tool') {
    return <span className="sp" />;
  }
  return <span className={indicator === 'failed' ? 'dot bad' : 'dot ok'} />;
}

function getSendLabel(chatMode: DashboardPresetExecutionFamily): string {
  if (chatMode === 'plan') { return 'Generate Plan'; }
  if (chatMode === 'repo-search') { return 'Search'; }
  if (chatMode === 'summary') { return 'Summarize'; }
  return 'Send';
}

export function ChatTab({
  sessions,
  selectedSessionId,
  selectedSession,
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

  function dispatchSend(): void {
    if (chatMode === 'plan') { void onSendPlan(); return; }
    if (chatMode === 'repo-search') { void onSendRepoSearch(); return; }
    void onSendMessage();
  }

  const usedRatio = contextUsage && contextUsage.contextWindowTokens > 0
    ? Math.max(0, Math.min(1, contextUsage.totalUsedTokens / contextUsage.contextWindowTokens))
    : 0;
  const contextTone = getContextBarFillTone(usedRatio);

  return (
    <>
      <div className="chat-lane">
        <button type="button" className="ghost-btn acc new" onClick={() => { void onCreateSession(); }} disabled={chatBusy}>
          + New session
        </button>
        <div className="runs">
          {sessions.map((session) => {
            const indicator = deriveSessionIndicator(session, {
              isActive: session.id === selectedSessionId,
              chatBusy,
              liveMessages,
            });
            return (
              <div
                key={session.id}
                className={selectedSessionId === session.id ? 'run sel' : 'run'}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session.id)}
              >
                <span className="t">{session.title}</span>
                <span className="m">
                  <SessionIndicatorMark indicator={indicator} /> {SESSION_INDICATOR_LABELS[indicator]} · {formatDate(session.updatedAtUtc)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="chat-main">
        {selectedSession ? (
          <>
            <div className="chat-head">
              <span>Preset</span>
              <select
                value={selectedChatPreset?.id || ''}
                onChange={(event) => { void onUpdateSessionPreset(event.target.value); }}
                disabled={chatBusy || webPresets.length === 0}
              >
                {webPresets.length === 0 ? <option value="">No presets</option> : null}
                {webPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
              <button
                type="button"
                className={webSearchEnabled ? 'hchip on' : 'hchip'}
                onClick={() => { void onToggleWebSearchEnabled(!webSearchEnabled); }}
                disabled={chatBusy}
              >
                web search
              </button>
              {isDirectChatMode ? (
                <button
                  type="button"
                  className={isThinkingEnabledForCurrentSession ? 'hchip on' : 'hchip'}
                  onClick={() => { void onToggleThinking(!isThinkingEnabledForCurrentSession); }}
                  disabled={chatBusy}
                >
                  per-step thinking
                </button>
              ) : null}
              <button type="button" className="ghost-btn" onClick={() => { void onDeleteSession(); }} disabled={chatBusy || !selectedSessionId}>
                Delete
              </button>
            </div>

            {selectedSession.condensedSummary && (
              <details className="card">
                <summary>Condensed Summary</summary>
                <pre className="mono">{selectedSession.condensedSummary}</pre>
              </details>
            )}

            <div className="msgs" ref={chatLogRef}>
              {promptContext && displayedSystemPromptContent.trim() ? (
                <article className="msg ai system_context">
                  <div className="who">system · first message</div>
                  <details className="system-context-bubble">
                    <summary>{promptContext.label}</summary>
                    <pre className="mono">{displayedSystemPromptContent}</pre>
                  </details>
                </article>
              ) : null}
              {groupMessagesIntoTurns(visibleMessages, new Set(liveMessages.map((message) => message.id))).map((turn) => {
                if (turn.steps.length === 0) {
                  const message = turn.main;
                  if (!message) { return null; }
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

            {chatError ? (
              <div className="err-banner">
                <span>{chatError}</span>
                <button type="button" className="mini-btn" onClick={dispatchSend} disabled={chatBusy || !chatInput.trim()}>Retry</button>
                <a className="mini-btn" href="?tab=runs">Open logs</a>
              </div>
            ) : null}

            <div className="composer">
              {showSettings ? (
                <SettingsPopover
                  contextUsage={contextUsage}
                  liveToolPromptTokenCount={liveToolPromptTokenCount}
                  isRepoToolMode={isRepoToolMode}
                  chatBusy={chatBusy}
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
              {isRepoToolMode ? (
                <div className="composer-plan-row">
                  <input
                    className="composer-plan-root"
                    placeholder="Repo folder path…"
                    value={planRepoRootInput}
                    onChange={(event) => onChangePlanRepoRoot(event.target.value)}
                    disabled={chatBusy}
                  />
                  <button type="button" className="ghost-btn" onClick={() => { void onSavePlanRepoRoot(); }} disabled={chatBusy || !planRepoRootInput.trim()}>
                    Directory
                  </button>
                </div>
              ) : null}
              {contextUsage ? (
                <div className={contextTone === 'warn' ? 'ctx warn' : 'ctx'} title={`context ${formatNumber(contextUsage.totalUsedTokens)} / ${formatNumber(contextUsage.contextWindowTokens)}`}>
                  <i style={{ width: `${usedRatio * 100}%` }} />
                </div>
              ) : null}
              <div className="row">
                <button
                  type="button"
                  className={showSettings ? 'settings-toggle active' : 'settings-toggle'}
                  onClick={onToggleSettings}
                  aria-label="Toggle settings"
                  title="Toggle settings"
                >
                  &#9881;
                </button>
                <textarea
                  className="input"
                  placeholder={chatMode === 'plan' ? 'Describe the feature to plan…' : chatMode === 'repo-search' ? 'Enter a repo search query…' : chatMode === 'summary' ? 'Enter a summary request…' : 'Message SiftKit…'}
                  value={chatInput}
                  onChange={(event) => onChangeChatInput(event.target.value)}
                  rows={2}
                />
                {contextUsage ? (
                  <span className="ctx-label">{formatCompactTokenCount(contextUsage.totalUsedTokens)} / {formatCompactTokenCount(contextUsage.contextWindowTokens)}</span>
                ) : null}
                <button
                  type="button"
                  className="send"
                  onClick={dispatchSend}
                  disabled={chatBusy || !chatInput.trim()}
                >
                  {chatBusy ? 'Stop' : getSendLabel(chatMode)}
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="hint">Create or pick a session.</p>
        )}
      </div>
    </>
  );
}

function SettingsPopover(props: {
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  isRepoToolMode: boolean;
  chatBusy: boolean;
  onCondense(): Promise<void>;
}) {
  const { contextUsage, liveToolPromptTokenCount, isRepoToolMode, chatBusy, onCondense } = props;
  if (!contextUsage) { return null; }
  const hasEstimatedUsage = Number(contextUsage.estimatedTokenFallbackTokens || 0) > 0;
  return (
    <div className={contextUsage.shouldCondense ? 'composer-settings-popover usage warning' : 'composer-settings-popover usage'}>
      <strong>
        {hasEstimatedUsage ? (
          <span title="Replayable chat context token count is unavailable because this session contains fallback estimates.">
            Context: token count unavailable
          </span>
        ) : (
          <span title="Replayable chat context tokens in this session.">
            Context: {formatNumber(contextUsage.chatUsedTokens)} / {formatNumber(contextUsage.contextWindowTokens)} tokens
          </span>
        )}
      </strong>
      {hasEstimatedUsage ? (
        <span title="Backend tokenization was unavailable for at least one persisted context component.">
          Token counts unavailable
        </span>
      ) : (
        <>
          <span title="Format: chat_tokens (total_tokens_including_tool_outputs).">
            Remaining: {formatNumber(contextUsage.remainingTokens)}
            {' | '}
            {formatNumber(contextUsage.chatUsedTokens)} ({formatNumber(contextUsage.totalUsedTokens)} with tools)
            {' | '}
            Warn at: {formatNumber(contextUsage.warnThresholdTokens)}
          </span>
          <span title="Tokens from preserved assistant thinking/reasoning text that can be replayed into the next request.">
            Thinking/reasoning: {formatNumber(contextUsage.thinkingUsedTokens || 0)}
          </span>
        </>
      )}
      {isRepoToolMode && Number.isFinite(liveToolPromptTokenCount) ? (
        <span title="Latest backend prompt_tokens for an active plan/repo-search tool step.">
          Live Step Prompt Tokens (backend): {formatNumber(liveToolPromptTokenCount)}
        </span>
      ) : null}
      {contextUsage.shouldCondense && (
        <button type="button" onClick={() => { void onCondense(); }} disabled={chatBusy}>Condense Now</button>
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
    : props.available && typeof props.tokenCount === 'number' && props.tokenSource === 'llama.cpp'
      ? `${formatNumber(props.tokenCount)} tokens`
      : props.available
        ? 'tokens unavailable'
        : 'not found';
  const title = props.enabled ? props.disableTitle : props.enableTitle;
  return (
    <button
      type="button"
      className={props.enabled ? 'repo-auto-append-button on' : 'repo-auto-append-button off'}
      onClick={props.onToggle}
      aria-label={`${props.enabled ? 'Disable' : 'Enable'} ${props.label === 'File scan' ? 'file scan' : props.label} auto-append`}
      title={`${title}. ${props.label}: ${tokenLabel}${props.available && props.tokenSource === 'llama.cpp' ? ` (${props.tokenSource})` : ''}.`}
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
      : message.role === 'user' ? 'You' : 'SiftKit';
  return (
    <div className="who">
      <span>{messageLabel} · {isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        <span className="msg-tokens">{formatTokenLabel(getReplayDisplayTokenCount(message))}</span>
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
    </div>
  );
}

function renderMessageBody(message: ChatMessage, isDirectChatMode: boolean, isLive: boolean) {
  const messageKind = normalizeMessageKind(message);
  const groundingStatusLabel = messageKind === 'assistant_answer'
    ? getGroundingStatusLabel(message.groundingStatus)
    : null;
  if (messageKind === 'assistant_tool_call') {
    return <ToolCallCard message={message} />;
  }
  if (messageKind === 'assistant_thinking') {
    return <div className="think">{message.content}</div>;
  }
  if (message.role === 'assistant') {
    return (
      <div className={isLive ? 'markdown-body caret' : 'markdown-body'}>
        {groundingStatusLabel ? <span className="chat-grounding-badge">{groundingStatusLabel}</span> : null}
        {isDirectChatMode && message.thinkingContent ? (
          <details className="thinking-box">
            <summary>Thinking</summary>
            <pre className="mono">{message.thinkingContent}</pre>
          </details>
        ) : null}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
    );
  }
  return <p className="user-message">{message.content}</p>;
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
  const tone = message.role === 'user' ? 'user' : 'ai';
  return (
    <article className={`msg ${tone} ${messageKind}${extraClass ? ` ${extraClass}` : ''}${isLive ? ' live' : ''}`}>
      <MessageHeader message={message} isLive={isLive} chatBusy={chatBusy} onDeleteMessage={onDeleteMessage} />
      {renderMessageBody(message, isDirectChatMode, isLive)}
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
  const aggregateTokens = getTurnTokenDisplay(turn.messages);
  const headerTimestamp = turn.main ? turn.main.createdAtUtc : turn.messages[0]?.createdAtUtc ?? null;
  const tokenLabel = aggregateTokens.tokenCount === null
    ? 'tokens unavailable'
    : aggregateTokens.exact
      ? formatTokenLabel(aggregateTokens.tokenCount, 'context tokens')
      : `${formatNumber(aggregateTokens.tokenCount)} known tokens`;
  const tokenTitle = aggregateTokens.tokenCount === null
    ? 'tokens unavailable'
    : aggregateTokens.exact
      ? `${formatNumber(aggregateTokens.tokenCount)} internal run tokens`
      : `${formatNumber(aggregateTokens.tokenCount)} known exact tokens; some token components are unavailable`;
  return (
    <article className={`msg ai turn${turn.isLive ? ' live' : ''}`}>
      <div className="who">
        <span>SiftKit · {turn.isLive ? 'live' : formatDate(headerTimestamp)}</span>
        <span className="msg-meta">
          <span className="msg-tokens" title={tokenTitle}>{tokenLabel}</span>
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
      </div>
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
