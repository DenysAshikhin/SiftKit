import { useEffect, useState } from 'react';
import {
  cancelBenchmarkSession,
  getBenchmarkQuestionPresets,
  getBenchmarkSession,
  getBenchmarkSessions,
  openBenchmarkSessionEvents,
  startBenchmarkSession,
  updateBenchmarkAttemptGrade,
} from '../api';
import { readSearchParams } from '../lib/format';
import type {
  DashboardBenchmarkAttempt,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkSession,
  DashboardBenchmarkSortKey,
  DashboardBenchmarkStartRequest,
  DashboardModelRuntimePreset,
  JsonObject,
} from '../types';
import type { BenchmarkTabProps } from '../tabs/BenchmarkTab';
import type { ToastLevel } from './useToasts';

export type DashboardBenchmarkManagedPresetSelectionInput = {
  questionPresetIds: string[];
  managedPresetIds: string[];
  repetitions: number;
  specOverrides: JsonObject[];
};

export function buildBenchmarkStartRequest(input: DashboardBenchmarkManagedPresetSelectionInput): DashboardBenchmarkStartRequest {
  return {
    questionPresetIds: input.questionPresetIds,
    managedPresetIds: input.managedPresetIds,
    repetitions: input.repetitions,
    specOverrides: input.specOverrides,
  };
}

export type BenchmarkController = {
  tabProps: BenchmarkTabProps;
  selectedBenchmarkSessionId: string;
};

export function useBenchmarkController(deps: {
  enqueueToast: (level: ToastLevel, text: string) => void;
  refreshToken: number;
  requestDashboardDataRefresh: () => void;
  tab: string;
  managedPresets: DashboardModelRuntimePreset[];
}): BenchmarkController {
  const params = readSearchParams();
  const [benchmarkQuestionPresets, setBenchmarkQuestionPresets] = useState<DashboardBenchmarkQuestionPreset[]>([]);
  const [benchmarkSessions, setBenchmarkSessions] = useState<DashboardBenchmarkSession[]>([]);
  const [selectedBenchmarkSessionId, setSelectedBenchmarkSessionId] = useState(params.get('benchmarkSession') || '');
  const [selectedBenchmarkSession, setSelectedBenchmarkSession] = useState<DashboardBenchmarkSession | null>(null);
  const [benchmarkAttempts, setBenchmarkAttempts] = useState<DashboardBenchmarkAttempt[]>([]);
  const [benchmarkLiveLogLines, setBenchmarkLiveLogLines] = useState<string[]>([]);
  const [selectedBenchmarkQuestionPresetIds, setSelectedBenchmarkQuestionPresetIds] = useState<string[]>([]);
  const [selectedBenchmarkManagedPresetIds, setSelectedBenchmarkManagedPresetIds] = useState<string[]>([]);
  const [benchmarkRepetitions, setBenchmarkRepetitions] = useState(1);
  const [benchmarkSpecOverrideLabel, setBenchmarkSpecOverrideLabel] = useState('Current spec settings');
  const [benchmarkSortKey, setBenchmarkSortKey] = useState<DashboardBenchmarkSortKey>('generationTokensPerSecond');
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [benchmarkStarting, setBenchmarkStarting] = useState(false);
  const [benchmarkCancelling, setBenchmarkCancelling] = useState(false);

  const managedPresets = deps.managedPresets;

  const sortedBenchmarkAttempts = [...benchmarkAttempts].sort((left, right) => {
    if (benchmarkSortKey === 'completionSpeed') {
      return Number(left.durationMs || 0) - Number(right.durationMs || 0);
    }
    if (benchmarkSortKey === 'failureCount') {
      return Number(left.status === 'failed') - Number(right.status === 'failed');
    }
    if (benchmarkSortKey === 'sampleCount') {
      return left.repeatIndex - right.repeatIndex;
    }
    return Number(right[benchmarkSortKey] || 0) - Number(left[benchmarkSortKey] || 0);
  });

  useEffect(() => {
    let cancelled = false;
    async function refreshBenchmarkData() {
      setBenchmarkLoading(true);
      setBenchmarkError(null);
      try {
        const [presetResponse, sessionResponse] = await Promise.all([
          getBenchmarkQuestionPresets(),
          getBenchmarkSessions(50),
        ]);
        if (cancelled) {
          return;
        }
        setBenchmarkQuestionPresets(presetResponse.presets);
        setBenchmarkSessions(sessionResponse.sessions);
        setSelectedBenchmarkQuestionPresetIds((previous) => (
          previous.length > 0 ? previous : presetResponse.presets.filter((preset) => preset.enabled).slice(0, 3).map((preset) => preset.id)
        ));
        const nextSelectedSessionId = selectedBenchmarkSessionId || sessionResponse.sessions[0]?.id || '';
        if (nextSelectedSessionId && nextSelectedSessionId !== selectedBenchmarkSessionId) {
          setSelectedBenchmarkSessionId(nextSelectedSessionId);
        }
      } catch (error) {
        if (!cancelled) {
          setBenchmarkError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setBenchmarkLoading(false);
        }
      }
    }
    if (deps.tab === 'benchmark') {
      void refreshBenchmarkData();
    }
    return () => { cancelled = true; };
  }, [deps.tab, deps.refreshToken]);

  useEffect(() => {
    if (!selectedBenchmarkSessionId) {
      setSelectedBenchmarkSession(null);
      setBenchmarkAttempts([]);
      return;
    }
    let cancelled = false;
    void getBenchmarkSession(selectedBenchmarkSessionId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedBenchmarkSession(detail.session);
          setBenchmarkAttempts(detail.attempts);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBenchmarkError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [selectedBenchmarkSessionId, deps.refreshToken]);

  useEffect(() => {
    if (!selectedBenchmarkSessionId || selectedBenchmarkSession?.status !== 'running') {
      return;
    }
    return openBenchmarkSessionEvents(selectedBenchmarkSessionId, (eventName, payload) => {
      if (eventName === 'log' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const text = String(payload.text || '');
        if (text) {
          setBenchmarkLiveLogLines((previous) => [...previous, text.trimEnd()].slice(-200));
        }
      }
      if (eventName === 'attempt' || eventName === 'session' || eventName === 'done') {
        deps.requestDashboardDataRefresh();
      }
      if (eventName === 'error' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        setBenchmarkError(String(payload.error || 'Benchmark stream error.'));
      }
    });
  }, [selectedBenchmarkSessionId, selectedBenchmarkSession?.status]);

  useEffect(() => {
    if (managedPresets.length === 0) {
      return;
    }
    setSelectedBenchmarkManagedPresetIds((previous) => (
      previous.length > 0 || !managedPresets[0] ? previous : [managedPresets[0].id]
    ));
  }, [managedPresets]);

  function toggleBenchmarkQuestionPreset(id: string): void {
    setSelectedBenchmarkQuestionPresetIds((previous) => (
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    ));
  }

  function toggleBenchmarkManagedPreset(id: string): void {
    setSelectedBenchmarkManagedPresetIds((previous) => (
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    ));
  }

  async function onStartBenchmark(): Promise<void> {
    setBenchmarkStarting(true);
    setBenchmarkError(null);
    setBenchmarkLiveLogLines([]);
    try {
      const response = await startBenchmarkSession(buildBenchmarkStartRequest({
        questionPresetIds: selectedBenchmarkQuestionPresetIds,
        managedPresetIds: selectedBenchmarkManagedPresetIds,
        repetitions: benchmarkRepetitions,
        specOverrides: [{ label: benchmarkSpecOverrideLabel }],
      }));
      setSelectedBenchmarkSessionId(response.session.id);
      setSelectedBenchmarkSession(response.session);
      setBenchmarkAttempts(response.attempts);
      deps.enqueueToast('info', 'Benchmark started.');
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkStarting(false);
    }
  }

  async function onCancelBenchmark(sessionId: string): Promise<void> {
    setBenchmarkCancelling(true);
    setBenchmarkError(null);
    try {
      await cancelBenchmarkSession(sessionId);
      deps.requestDashboardDataRefresh();
      deps.enqueueToast('warning', 'Benchmark cancellation requested.');
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkCancelling(false);
    }
  }

  async function onUpdateBenchmarkAttemptGrade(
    attemptId: string,
    outputQualityScore: number | null,
    toolUseQualityScore: number | null,
    reviewNotes: string | null,
  ): Promise<void> {
    try {
      const response = await updateBenchmarkAttemptGrade(attemptId, {
        outputQualityScore,
        toolUseQualityScore,
        reviewNotes,
        reviewedBy: 'codex',
      });
      setBenchmarkAttempts((previous) => previous.map((attempt) => (
        attempt.id === response.attempt.id ? response.attempt : attempt
      )));
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    }
  }

  const tabProps: BenchmarkTabProps = {
    questionPresets: benchmarkQuestionPresets,
    sessions: benchmarkSessions,
    selectedSession: selectedBenchmarkSession,
    attempts: sortedBenchmarkAttempts,
    liveLogLines: benchmarkLiveLogLines,
    managedPresets,
    selectedQuestionPresetIds: selectedBenchmarkQuestionPresetIds,
    selectedManagedPresetIds: selectedBenchmarkManagedPresetIds,
    repetitions: benchmarkRepetitions,
    specOverrideLabel: benchmarkSpecOverrideLabel,
    loading: benchmarkLoading,
    error: benchmarkError,
    starting: benchmarkStarting,
    cancelling: benchmarkCancelling,
    sortKey: benchmarkSortKey,
    onToggleQuestionPreset: toggleBenchmarkQuestionPreset,
    onToggleManagedPreset: toggleBenchmarkManagedPreset,
    onRepetitionsChange: (value) => setBenchmarkRepetitions(Math.max(1, Math.trunc(Number(value) || 1))),
    onSpecOverrideLabelChange: setBenchmarkSpecOverrideLabel,
    onStartBenchmark,
    onCancelBenchmark,
    onSortChange: setBenchmarkSortKey,
    onSelectSession: setSelectedBenchmarkSessionId,
    onUpdateAttemptGrade: onUpdateBenchmarkAttemptGrade,
  };

  return { tabProps, selectedBenchmarkSessionId };
}
