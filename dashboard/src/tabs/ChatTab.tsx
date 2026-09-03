import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  formatCompactTokenCount,
  formatDate,
  formatLiveMessageTokenLabel,
  formatMessageTokenLabel,
  formatNumber,
  formatTokenLabel,
  getTurnTokenDisplay,
} from '../lib/format';
import {
  buildLiveMessageScrollSignature,
} from '../lib/chatMessages';
import { getContextBarFillTone } from '../lib/context-bar-tone';
import { deriveSessionIndicator, isSessionBusy, type SessionIndicator } from '../lib/chat-session-state';
import type { ChatSessionRuntime } from '../lib/chat-session-runtime-store';
import { ToolCallCard } from '../components/ToolCallCard';
import { ToolActivityRow } from '../components/ToolActivityRow';
import { PendingImageStrip } from '../components/PendingImageStrip';
import { MessageImages } from '../components/MessageImages';
import { ChatStatsBar, type ChatSessionStats } from '../components/ChatStatsBar';
import { RepoAgentApprovalCard, RepoAgentApprovalRow } from '../components/RepoAgentApprovalCard';
import type { RepoAgentDecision } from '../api';
import type { LastTurnTelemetry } from '../lib/format';
import { downscaleDataUrl, type PendingImage } from '../lib/downscale-image';
import { extractClipboardImageFiles } from '../lib/clipboard-images';
import { useChatScroll } from '../hooks/useChatScroll';
import { useSmoothedText } from '../hooks/useSmoothedText';
import { groupMessagesIntoTurns, type ChatTurn } from '../lib/chatTurns';
import { LIVE_USER_MESSAGE_ID } from '../lib/chat-live-messages';
import { hasSamePresetExecutionContext } from '../dashboard-presets';
import type {
  ChatSession,
  ContextUsage,
  DashboardPreset,
  DashboardPresetExecutionFamily,
} from '../types';
import type { ChatMessage, ChatToolCallMessage } from '../types';

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

export type ChatSessionIndicatorView = {
  sessionId: string;
  indicator: SessionIndicator;
};

export type ChatTabProps = {
  sessions: ChatSession[];
  selectedSessionId: string;
  selectedSession: ChatSession | null;
  selectedRuntime: ChatSessionRuntime | null;
  sessionRuntimes: ChatSessionRuntime[];
  sessionPromptCacheStats: ChatSessionStats;
  lastTurnTelemetry: LastTurnTelemetry;
  webPresets: DashboardPreset[];
  selectedChatPreset: DashboardPreset | null;
  chatMode: DashboardPresetExecutionFamily | null;
  isDirectChatMode: boolean;
  isRepoToolMode: boolean;
  isThinkingEnabledForCurrentSession: boolean;
  webSearchEnabled: boolean;
  showSettings: boolean;
  onSelectSession(sessionId: string): void;
  onToggleSettings(): void;
  onChangePlanRepoRoot(value: string): void;
  onChangeDraft(value: string): void;
  onCreateSession(): Promise<void>;
  onDeleteSession(): Promise<void>;
  onUpdateSessionPreset(presetId: string): Promise<void>;
  onToggleThinking(enabled: boolean): Promise<void>;
  onToggleWebSearchEnabled(enabled: boolean): Promise<void>;
  onSavePlanRepoRoot(): Promise<void>;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  onCondense(): Promise<void>;
  onSendPlan(): Promise<void>;
  onSendRepoSearch(): Promise<void>;
  onSendRepoAgent(): Promise<void>;
  onSubmitRepoAgentDecision(decision: RepoAgentDecision): Promise<void>;
  onStopOperation(): Promise<void>;
  onSendMessage(): Promise<void>;
  onPendingImagesChange(images: PendingImage[]): void;
  onPendingImagesAppend(sessionId: string, images: PendingImage[]): void;
  onPendingImageError(sessionId: string, message: string): void;
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

function getSendLabel(chatMode: DashboardPresetExecutionFamily | null): string {
  if (chatMode === 'plan') { return 'Generate Plan'; }
  if (chatMode === 'repo-search') { return 'Search'; }
  if (chatMode === 'repo-agent') { return 'Run Agent'; }
  if (chatMode === 'summary') { return 'Summarize'; }
  return 'Send';
}

export async function readImageFile(file: File, maxPixels: number): Promise<PendingImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`cannot read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  return downscaleDataUrl(dataUrl, maxPixels);
}

export async function readImageFiles(files: File[], maxPixels: number): Promise<PendingImage[]> {
  const results: PendingImage[] = [];
  for (const file of files) {
    results.push(await readImageFile(file, maxPixels));
  }
  return results;
}

function buildSessionIndicators(
  sessions: ChatSession[],
  sessionRuntimes: ChatSessionRuntime[],
): ChatSessionIndicatorView[] {
  return sessions.map((session) => {
    const runtime = sessionRuntimes.find((r) => r.sessionId === session.id) ?? null;
    return {
      sessionId: session.id,
      indicator: deriveSessionIndicator(session, runtime),
    };
  });
}

export function ChatTab({
  sessions,
  selectedSessionId,
  selectedSession,
  selectedRuntime,
  sessionRuntimes,
  sessionPromptCacheStats,
  lastTurnTelemetry,
  webPresets,
  selectedChatPreset,
  chatMode,
  isDirectChatMode,
  isRepoToolMode,
  isThinkingEnabledForCurrentSession,
  webSearchEnabled,
  showSettings,
  onSelectSession,
  onToggleSettings,
  onChangePlanRepoRoot,
  onChangeDraft,
  onCreateSession,
  onDeleteSession,
  onUpdateSessionPreset,
  onToggleThinking,
  onToggleWebSearchEnabled,
  onSavePlanRepoRoot,
  onDeleteMessage,
  onDeleteTurn,
  onDeleteMessageImage,
  onCondense,
  onSendPlan,
  onSendRepoSearch,
  onSendRepoAgent,
  onSubmitRepoAgentDecision,
  onStopOperation,
  onSendMessage,
  onPendingImagesChange,
  onPendingImagesAppend,
  onPendingImageError,
}: ChatTabProps) {
  const pendingImageReadState = React.useRef({ generation: 0, tail: Promise.resolve() });
  const [pendingImageReadCount, setPendingImageReadCount] = React.useState(0);
  const planRepoRootInput = selectedRuntime?.planRepoRootInput ?? '';
  const contextUsage = selectedRuntime?.contextUsage ?? null;
  const liveToolPromptTokenCount = selectedRuntime?.liveToolPromptTokenCount ?? null;
  const liveMessages = selectedRuntime?.liveMessages ?? [];
  const chatError = selectedRuntime?.error ?? null;
  const warnings = selectedRuntime?.warnings ?? [];
  const draft = selectedRuntime?.draft ?? '';
  const pendingImages = selectedRuntime?.pendingImages ?? [];
  const effectiveImagePixelCeiling = contextUsage?.effectiveImagePixelCeiling ?? null;
  const persistedMessages = selectedSession ? selectedSession.messages : [];
  // The persisted flag is the boundary, exactly as it is for the history the model
  // replays: a flagged row is compacted history wherever it sits in the session.
  const compactedMessages = persistedMessages.filter((message) => message.compressedIntoSummary === true);
  const liveHistory = persistedMessages.filter((message) => message.compressedIntoSummary !== true);
  const compactionSummaryMessage = liveHistory.find((message) => message.kind === 'compaction_summary') ?? null;
  const conversationMessages = liveHistory.filter((message) => message.kind !== 'compaction_summary');
  const visibleMessages = [...conversationMessages, ...liveMessages];
  const promptContext = selectedSession?.promptContext ?? null;
  const visibleMessageIds = visibleMessages.map((message) => message.id).join('|');
  const liveMessageScrollSignature = buildLiveMessageScrollSignature(liveMessages);
  const {
    chatLogRef,
    onChatLogScroll,
    jumpToBottom,
    showJumpToBottom,
  } = useChatScroll(
    selectedSessionId,
    visibleMessageIds,
    liveMessageScrollSignature,
    selectedRuntime?.pendingApproval?.approvalId ?? null,
  );
  const sessionIndicators = buildSessionIndicators(sessions, sessionRuntimes);
  const selectedSessionBusy = isSessionBusy(selectedRuntime);
  const ownsActiveOperation = selectedRuntime?.activity.kind === 'local';
  const pendingUserMessageId = selectedRuntime?.awaitingResponse ? LIVE_USER_MESSAGE_ID : null;

  React.useEffect(() => {
    pendingImageReadState.current.generation += 1;
    pendingImageReadState.current.tail = Promise.resolve();
    setPendingImageReadCount(0);
  }, [selectedSessionId]);

  function enqueuePendingImageRead(files: File[], maxPixels: number): void {
    if (files.length === 0) {
      return;
    }
    const generation = pendingImageReadState.current.generation;
    const sessionId = selectedSessionId;
    const fileCount = files.length;
    setPendingImageReadCount((previous) => previous + fileCount);
    const batch = readImageFiles(files, maxPixels);
    pendingImageReadState.current.tail = pendingImageReadState.current.tail.then(async () => {
      try {
        const images = await batch;
        if (generation === pendingImageReadState.current.generation) {
          onPendingImagesAppend(sessionId, images);
        }
      } catch (error) {
        if (generation === pendingImageReadState.current.generation) {
          onPendingImageError(sessionId, error instanceof Error ? error.message : String(error));
        }
      } finally {
        setPendingImageReadCount((previous) => Math.max(0, previous - fileCount));
      }
    });
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (selectedSessionBusy || effectiveImagePixelCeiling === null) {
      return;
    }
    const files = extractClipboardImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    enqueuePendingImageRead(files, effectiveImagePixelCeiling);
  }

  function dispatchSend(): void {
    if (chatMode === 'plan') { void onSendPlan(); return; }
    if (chatMode === 'repo-search') { void onSendRepoSearch(); return; }
    if (chatMode === 'repo-agent') { void onSendRepoAgent(); return; }
    void onSendMessage();
  }

  function changePreset(presetId: string): void {
    const nextPreset = webPresets.find((preset) => preset.id === presetId) ?? null;
    if (
      selectedChatPreset
      && nextPreset
      && !hasSamePresetExecutionContext(selectedChatPreset, nextPreset)
      && !window.confirm(
        `Switching from “${selectedChatPreset.label}” to “${nextPreset.label}” keeps the conversation history, but invalidates the current model context/prompt cache. Continue?`,
      )
    ) {
      return;
    }
    void onUpdateSessionPreset(presetId);
  }

  const usedRatio = contextUsage && contextUsage.contextWindowTokens > 0
    ? Math.max(0, Math.min(1, contextUsage.totalUsedTokens / contextUsage.contextWindowTokens))
    : 0;
  const contextTone = getContextBarFillTone(usedRatio);

  return (
    <>
      <div className="chat-lane">
        <button type="button" className="ghost-btn acc new" onClick={() => { void onCreateSession(); }}>
          + New session
        </button>
        <div className="runs">
          {sessions.map((session) => {
            const indicatorView = sessionIndicators.find((v) => v.sessionId === session.id);
            const indicator = indicatorView?.indicator ?? 'completed';
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
                onChange={(event) => changePreset(event.target.value)}
                disabled={selectedSessionBusy || webPresets.length === 0}
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
                disabled={selectedSessionBusy}
              >
                web search
              </button>
              {isDirectChatMode ? (
                <button
                  type="button"
                  className={isThinkingEnabledForCurrentSession ? 'hchip on' : 'hchip'}
                  onClick={() => { void onToggleThinking(!isThinkingEnabledForCurrentSession); }}
                  disabled={selectedSessionBusy}
                >
                  per-step thinking
                </button>
              ) : null}
              <button type="button" className="ghost-btn" onClick={() => { void onDeleteSession(); }} disabled={selectedSessionBusy || !selectedSessionId}>
                Delete
              </button>
            </div>

            <div className="message-pane">
              <div className="msgs" ref={chatLogRef} onScroll={onChatLogScroll}>
              {compactedMessages.length > 0 ? (
                <CompactedHistoryPanel
                  compactedMessages={compactedMessages}
                  summary={compactionSummaryMessage}
                  sessionId={selectedSessionId}
                  isDirectChatMode={isDirectChatMode}
                  chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage}
                  onDeleteMessageImage={onDeleteMessageImage}
                />
              ) : null}
              {promptContext && promptContext.content.trim() ? (
                <article className="msg ai system_context">
                  <div className="who">system · first message</div>
                  <details className="system-context-bubble">
                    <summary>{promptContext.label}</summary>
                    <pre className="mono">{promptContext.content}</pre>
                  </details>
                </article>
              ) : null}
              {groupMessagesIntoTurns(visibleMessages, new Set(liveMessages.map((message) => message.id))).map((turn) => {
                if (turn.steps.length === 0
                  && turn.liveThinking.length === 0
                  && turn.recentActivities.length === 0
                  && !turn.showRecentActivity) {
                  const message = turn.main;
                  if (!message) { return null; }
                  if (message.kind === 'repo_agent_approval') {
                    return (
                      <RepoAgentApprovalRow
                        key={message.id}
                        decision={message.approvalDecision}
                        command={message.approvalCommand}
                        reason={message.approvalReason}
                        decidedAtUtc={message.createdAtUtc}
                      />
                    );
                  }
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      sessionId={selectedSessionId}
                      isLive={turn.isLive}
                      isPending={message.id === pendingUserMessageId}
                      isDirectChatMode={isDirectChatMode}
                      chatBusy={selectedSessionBusy}
                      onDeleteMessage={onDeleteMessage}
                      onDeleteMessageImage={onDeleteMessageImage}
                    />
                  );
                }
                return (
                  <ChatTurnBubble
                    key={turn.key}
                    turn={turn}
                    sessionId={selectedSessionId}
                    isDirectChatMode={isDirectChatMode}
                    chatBusy={selectedSessionBusy}
                    onDeleteMessage={onDeleteMessage}
                    onDeleteMessageImage={onDeleteMessageImage}
                    onDeleteTurn={onDeleteTurn}
                  />
                );
              })}
              {selectedRuntime?.resolvedApproval ? (
                <RepoAgentApprovalRow
                  decision={selectedRuntime.resolvedApproval.decision.decision}
                  command={selectedRuntime.resolvedApproval.approval.command}
                  reason={selectedRuntime.resolvedApproval.decision.decision === 'deny'
                    ? selectedRuntime.resolvedApproval.decision.reason
                    : null}
                  decidedAtUtc={selectedRuntime.resolvedApproval.decidedAtUtc}
                />
              ) : null}
              {selectedRuntime?.pendingApproval ? (
                <RepoAgentApprovalCard
                  approval={selectedRuntime.pendingApproval}
                  onDecide={(decision) => { void onSubmitRepoAgentDecision(decision); }}
                />
              ) : null}
              {selectedRuntime?.awaitingResponse ? (
                <section className="recent-activity" aria-label="Recent activity">
                  <div className="recent-activity-header">
                    <span>Recent activity</span>
                  </div>
                  <div className="recent-activity-list" />
                </section>
              ) : null}
              </div>
              {showJumpToBottom ? (
                <button type="button" className="jump-to-bottom" onClick={jumpToBottom}>
                  Jump to bottom
                </button>
              ) : null}
            </div>

            {chatError ? (
              <div className="err-banner">
                <span>{chatError}</span>
                <button type="button" className="mini-btn" onClick={dispatchSend} disabled={selectedSessionBusy || (!draft.trim() && pendingImages.length === 0)}>Retry</button>
                <a className="mini-btn" href="?tab=runs">Open logs</a>
              </div>
            ) : null}

            {warnings.length > 0 ? (
              <div className="warning-banner" role="status">
                {warnings.map((warning, index) => (
                  <span key={`${warning}:${index}`}>{warning}</span>
                ))}
              </div>
            ) : null}

            <div className="composer">
              {showSettings ? (
                <SettingsPopover
                  contextUsage={contextUsage}
                  liveToolPromptTokenCount={liveToolPromptTokenCount}
                  isRepoToolMode={isRepoToolMode}
                  chatBusy={selectedSessionBusy}
                  onCondense={onCondense}
                />
              ) : null}
              {isRepoToolMode ? (
                <div className="composer-plan-row">
                  <input
                    className="composer-plan-root"
                    placeholder="Repo folder path…"
                    value={planRepoRootInput}
                    onChange={(event) => onChangePlanRepoRoot(event.target.value)}
                    disabled={selectedSessionBusy}
                  />
                  <button type="button" className="ghost-btn" onClick={() => { void onSavePlanRepoRoot(); }} disabled={selectedSessionBusy || !planRepoRootInput.trim()}>
                    Directory
                  </button>
                </div>
              ) : null}
              {contextUsage ? (
                <div className={contextTone === 'warn' ? 'ctx warn' : 'ctx'} title={`context ${formatNumber(contextUsage.totalUsedTokens)} / ${formatNumber(contextUsage.contextWindowTokens)}`}>
                  <i style={{ width: `${usedRatio * 100}%` }} />
                </div>
              ) : null}
              <PendingImageStrip
                images={pendingImages}
                pendingCount={pendingImageReadCount}
                onChange={onPendingImagesChange}
              />
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
                  placeholder={chatMode === 'plan' ? 'Describe the feature to plan…' : chatMode === 'repo-search' ? 'Enter a repo search query…' : chatMode === 'repo-agent' ? 'Describe the task for the repo agent…' : chatMode === 'summary' ? 'Enter a summary request…' : 'Message SiftKit…'}
                  value={draft}
                  onChange={(event) => onChangeDraft(event.target.value)}
                  onPaste={handleComposerPaste}
                  rows={2}
                  disabled={selectedSessionBusy}
                />
                {contextUsage ? (
                  <span className="ctx-label">{formatCompactTokenCount(contextUsage.totalUsedTokens)} / {formatCompactTokenCount(contextUsage.contextWindowTokens)}</span>
                ) : null}
                <label className="mini-btn attach" title="Attach images">
                  Attach
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    disabled={selectedSessionBusy || effectiveImagePixelCeiling === null}
                    onChange={(event) => {
                      if (effectiveImagePixelCeiling === null) {
                        return;
                      }
                      enqueuePendingImageRead(
                        Array.from(event.currentTarget.files ?? []),
                        effectiveImagePixelCeiling,
                      );
                    }}
                  />
                </label>
                {ownsActiveOperation ? (
                  <button
                    type="button"
                    className="send stop"
                    onClick={() => { void onStopOperation(); }}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="send"
                    onClick={dispatchSend}
                    disabled={selectedSessionBusy || (!draft.trim() && pendingImages.length === 0)}
                  >
                    {getSendLabel(chatMode)}
                  </button>
                )}
              </div>
              <ChatStatsBar
                lastTurn={lastTurnTelemetry}
                sessionStats={sessionPromptCacheStats}
                contextUsage={contextUsage}
                streaming={selectedSessionBusy}
              />
            </div>
          </>
        ) : (
          <p className="hint">Create or pick a session.</p>
        )}
      </div>
    </>
  );
}

function CompactedHistoryPanel(props: {
  compactedMessages: ChatMessage[];
  /** Null when the rows were flagged but their summary row is no longer in the session. */
  summary: ChatMessage | null;
  sessionId: string;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
}) {
  const { compactedMessages, summary, sessionId, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteMessageImage } = props;
  const messageCount = compactedMessages.length;
  return (
    <section className="compaction">
      <details className="compaction-history">
        <summary className="compaction-divider">
          — Context compacted ({messageCount} {messageCount === 1 ? 'message' : 'messages'} summarized) —
        </summary>
        <div className="compaction-originals">
          {compactedMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              sessionId={sessionId}
              isLive={false}
              isPending={false}
              isDirectChatMode={isDirectChatMode}
              chatBusy={chatBusy}
              onDeleteMessage={onDeleteMessage}
              onDeleteMessageImage={onDeleteMessageImage}
            />
          ))}
        </div>
      </details>
      {summary ? (
        <article className="msg ai compaction-summary">
          <div className="who">assistant · Compacted summary</div>
          <div className="compaction-summary-body">{summary.content}</div>
        </article>
      ) : null}
    </section>
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
          <span title="Estimated tokens consumed by images attached in this session.">
            Images: {formatNumber(contextUsage.imageUsedTokens)}
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

function MessageHeader({ message, isLive, isPending, chatBusy, onDeleteMessage }: {
  message: ChatMessage;
  isLive: boolean;
  isPending: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
}) {
  const messageKind = message.kind;
  const messageLabel = messageKind === 'assistant_thinking'
    ? 'assistant thinking'
    : messageKind === 'assistant_tool_call'
      ? 'assistant tool'
      : message.role === 'user' ? 'You' : 'SiftKit';
  return (
    <div className="who">
      <span>{messageLabel} · {isPending ? 'sending…' : isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        {isPending ? <span className="sp" /> : null}
        <span className="msg-tokens" title="Text tokens, plus the estimated image tokens this message keeps in context.">
          {isLive ? formatLiveMessageTokenLabel(message) : formatMessageTokenLabel(message)}
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
    </div>
  );
}

function ThinkingBody({ message, isLive }: { message: ChatMessage; isLive: boolean }) {
  const content = useSmoothedText(message.content, isLive);
  return <div className="think">{content}</div>;
}

function AssistantAnswerBody({ message, isLive, isDirectChatMode }: {
  message: ChatMessage;
  isLive: boolean;
  isDirectChatMode: boolean;
}) {
  const content = useSmoothedText(message.content, isLive);
  const messageKind = message.kind;
  const groundingStatusLabel = messageKind === 'assistant_answer'
    ? getGroundingStatusLabel(message.groundingStatus)
    : null;
  return (
    <div className={isLive ? 'markdown-body caret' : 'markdown-body'}>
      {groundingStatusLabel ? <span className="chat-grounding-badge">{groundingStatusLabel}</span> : null}
      {isDirectChatMode && message.thinkingContent ? (
        <details className="thinking-box">
          <summary>Thinking</summary>
          <pre className="mono">{message.thinkingContent}</pre>
        </details>
      ) : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function renderMessageBody(
  message: ChatMessage,
  sessionId: string,
  isDirectChatMode: boolean,
  isLive: boolean,
  chatBusy: boolean,
  onDeleteMessageImage: (messageId: string, imageIndex: number) => Promise<void>,
) {
  const images = (
    <MessageImages
      key={`${sessionId}:${message.id}`}
      sessionId={sessionId}
      messageId={message.id}
      images={message.images ?? []}
      imageMeta={message.imageMeta ?? []}
      removedImageCount={message.removedImageCount ?? 0}
      chatBusy={chatBusy || isLive}
      onDeleteImage={(imageIndex: number) => onDeleteMessageImage(message.id, imageIndex)}
    />
  );
  if (message.kind === 'tool_image') {
    return images;
  }
  if (message.kind === 'assistant_tool_call') {
    return <ToolCallCard message={message} />;
  }
  if (message.kind === 'assistant_thinking') {
    return <ThinkingBody message={message} isLive={isLive} />;
  }
  if (message.role === 'assistant') {
    return <AssistantAnswerBody message={message} isLive={isLive} isDirectChatMode={isDirectChatMode} />;
  }
  return (
    <>
      <p className="user-message">{message.content}</p>
      {images}
    </>
  );
}

function MessageBubble({ message, sessionId, isLive, isPending, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteMessageImage, extraClass }: {
  message: ChatMessage;
  sessionId: string;
  isLive: boolean;
  isPending: boolean;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  extraClass?: string | undefined;
}) {
  const messageKind = message.kind;
  const tone = message.role === 'user' ? 'user' : 'ai';
  return (
    <article className={`msg ${tone} ${messageKind}${extraClass ? ` ${extraClass}` : ''}${isLive ? ' live' : ''}${isPending ? ' pending' : ''}`}>
      <MessageHeader message={message} isLive={isLive} isPending={isPending} chatBusy={chatBusy} onDeleteMessage={onDeleteMessage} />
      {renderMessageBody(message, sessionId, isDirectChatMode, isLive, chatBusy, onDeleteMessageImage)}
    </article>
  );
}

function ChatTurnBubble({ turn, sessionId, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteMessageImage, onDeleteTurn }: {
  turn: ChatTurn;
  sessionId: string;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  const aggregateTokens = getTurnTokenDisplay(turn);
  const headerTimestamp = turn.main ? turn.main.createdAtUtc : turn.messages[0]?.createdAtUtc ?? null;
  const tokenLabel = aggregateTokens.exact
    ? formatTokenLabel(aggregateTokens.tokenCount, 'context tokens')
    : `~${formatNumber(aggregateTokens.tokenCount)} context tokens`;
  const tokenTitle = turn.isLive
    ? 'Provisional unique token total across the bubbles currently streaming in this turn.'
    : 'Unique run tokens: aggregate model generation plus tool output and retained images; internal bubbles are not added twice.';
  const toolMessages = turn.messages.filter((message): message is ChatToolCallMessage => message.kind === 'assistant_tool_call');
  const latestTool = toolMessages[toolMessages.length - 1] ?? null;
  const toolProgress = latestTool ? `${toolMessages.length}/${latestTool.toolCallMaxTurns}` : null;
  const renderTurnMessage = (message: ChatMessage, extraClass?: string) => (
    <MessageBubble
      key={message.id}
      message={message}
      sessionId={sessionId}
      isLive={turn.isLive}
      isPending={false}
      isDirectChatMode={isDirectChatMode}
      chatBusy={chatBusy}
      onDeleteMessage={onDeleteMessage}
      onDeleteMessageImage={onDeleteMessageImage}
      extraClass={extraClass}
    />
  );
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
      {turn.steps.length > 0 ? (
        <details className="internal-logic">
          <summary>Internal Logic ({turn.steps.length})</summary>
          <div className="internal-logic-steps">
            {turn.steps.map((step) => renderTurnMessage(step))}
          </div>
        </details>
      ) : null}
      {turn.liveThinking.length > 0 ? (
        <div className="live-thinking-stack">
          {turn.liveThinking.map((thinking) => renderTurnMessage(thinking))}
        </div>
      ) : null}
      {turn.showRecentActivity ? (
        <section className="recent-activity" aria-label="Recent activity">
          <div className="recent-activity-header">
            <span>Recent activity</span>
            {toolProgress ? <span className="recent-activity-meta">{toolProgress}</span> : null}
          </div>
          <div className="recent-activity-list">
            {turn.recentActivities.map((activity) => <ToolActivityRow key={activity.key} group={activity} />)}
          </div>
        </section>
      ) : null}
      {turn.main ? renderTurnMessage(turn.main, 'turn-main') : null}
    </article>
  );
}
