import React from 'react';

import { formatNumber } from '../lib/format';
import type { LastTurnTelemetry } from '../lib/format';
import type { ContextUsage } from '../types';

export type ChatSessionStats = {
  cacheHitRate: number | null;
  promptCacheTokens: number;
  promptEvalTokens: number;
  acceptanceRate: number | null;
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
};

const PLACEHOLDER = '—';

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatRate(value: number | null): string {
  return value === null ? PLACEHOLDER : `${formatNumber(roundToTenth(value))} t/s`;
}

function formatMs(value: number | null): string {
  return value === null ? PLACEHOLDER : `${formatNumber(Math.round(value))} ms`;
}

function formatPercent(value: number | null): string {
  return value === null ? PLACEHOLDER : `${Math.round(value * 100)}%`;
}

function formatSessionRate(value: number | null): string {
  return value === null ? 'not measured yet' : `${formatNumber(roundToTenth(value))} t/s`;
}

function StatChip({ icon, value, tip }: { icon: string; value: string; tip: string }) {
  return (
    <span className="chat-stat" data-tip={tip} title={tip}>
      <span className="chat-stat-icon" aria-hidden="true">{icon}</span>
      <span className="chat-stat-value">{value}</span>
    </span>
  );
}

export function ChatStatsBar({ lastTurn, sessionStats, contextUsage, streaming }: {
  lastTurn: LastTurnTelemetry;
  sessionStats: ChatSessionStats;
  contextUsage: ContextUsage | null;
  streaming: boolean;
}) {
  return (
    <div className={streaming ? 'chat-stats streaming' : 'chat-stats'} role="status" aria-label="Inference performance">
      <StatChip
        icon="⚡"
        value={formatRate(lastTurn.promptTokensPerSecond)}
        tip={`Prompt processing speed on the last completed turn. Session average: ${formatSessionRate(sessionStats.promptTokensPerSecond)}.`}
      />
      <StatChip
        icon="▸"
        value={formatRate(lastTurn.generationTokensPerSecond)}
        tip={`Token generation speed on the last completed turn. Session average: ${formatSessionRate(sessionStats.generationTokensPerSecond)}.`}
      />
      <StatChip
        icon="⏱"
        value={formatMs(lastTurn.ttftMs)}
        tip="Time to first token — the prompt-eval duration the backend reported for the last completed turn."
      />
      <StatChip
        icon="⛁"
        value={formatPercent(sessionStats.cacheHitRate)}
        tip={`Share of prompt tokens served from the prompt cache across this session (${formatNumber(sessionStats.promptCacheTokens)} cached of ${formatNumber(sessionStats.promptCacheTokens + sessionStats.promptEvalTokens)}).`}
      />
      <StatChip
        icon="✦"
        value={formatPercent(sessionStats.acceptanceRate)}
        tip="Speculative-decoding acceptance rate across this session. Higher means the draft model is guessing well."
      />
      <StatChip
        icon="Σ"
        value={contextUsage === null ? PLACEHOLDER : formatNumber(contextUsage.totalUsedTokens)}
        tip="Tokens currently occupying the context window, including attached images and tool output."
      />
    </div>
  );
}
