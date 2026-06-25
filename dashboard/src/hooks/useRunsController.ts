import { useEffect, useState } from 'react';
import { deleteRunLogs, getRunDetail, getRuns, previewRunLogDelete } from '../api';
import {
  buildRunLogDeleteCriteria,
  describeRunLogDeleteCriteria,
  normalizeRunLogTypeFilter,
  toggleRunLogTypeFilter,
} from '../run-log-admin';
import { buildRunsSignature, classifyRunGroup, readSearchParams } from '../lib/format';
import { buildRepoSearchChatSteps } from '../lib/chat-steps';
import type { RunGroupFilter, RunLogDeleteType, RunRecord } from '../types';
import type { RunsTabProps } from '../tabs/RunsTab';
import type { RunsCacheReset } from './useDashboardRefresh';
import type { ToastLevel } from './useToasts';

type RunGroupKey = Exclude<RunGroupFilter, ''>;

export type RunDeleteController = {
  showModal: boolean;
  mode: 'count' | 'before_date';
  type: RunLogDeleteType;
  countInput: string;
  beforeDate: string;
  previewCount: number | null;
  previewBusy: boolean;
  busy: boolean;
  error: string | null;
  summary: string | null;
  hasCriteria: boolean;
  setMode(mode: 'count' | 'before_date'): void;
  setType(type: RunLogDeleteType): void;
  setCountInput(value: string): void;
  setBeforeDate(value: string): void;
  open(): void;
  close(): void;
  confirm(): Promise<void>;
};

export type RunsController = {
  tabProps: RunsTabProps;
  runDelete: RunDeleteController;
  search: string;
  kindFilter: RunGroupFilter;
  statusFilter: string;
  selectedRunId: string;
  refreshSelectedRunDetail(): Promise<void>;
};

export function useRunsController(deps: {
  enqueueToast: (level: ToastLevel, text: string) => void;
  refreshToken: number;
  runsCacheResetRef: { current: RunsCacheReset };
  requestDashboardDataRefresh: () => void;
}): RunsController {
  const params = readSearchParams();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') || '');
  const [kindFilter, setKindFilter] = useState<RunGroupFilter>(normalizeRunLogTypeFilter(params.get('kind') || ''));
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const [selectedRunId, setSelectedRunId] = useState(params.get('run') || '');
  const [selectedRunDetail, setSelectedRunDetail] = useState<Awaited<ReturnType<typeof getRunDetail>> | null>(null);
  const [repoSearchSimpleFlow, setRepoSearchSimpleFlow] = useState(true);
  const [showRunDeleteModal, setShowRunDeleteModal] = useState(false);
  const [runDeleteMode, setRunDeleteMode] = useState<'count' | 'before_date'>('count');
  const [runDeleteType, setRunDeleteType] = useState<RunLogDeleteType>('all');
  const [runDeleteCountInput, setRunDeleteCountInput] = useState('25');
  const [runDeleteBeforeDate, setRunDeleteBeforeDate] = useState('');
  const [runDeletePreviewCount, setRunDeletePreviewCount] = useState<number | null>(null);
  const [runDeletePreviewBusy, setRunDeletePreviewBusy] = useState(false);
  const [runDeleteBusy, setRunDeleteBusy] = useState(false);
  const [runDeleteError, setRunDeleteError] = useState<string | null>(null);

  const runDeleteCriteria = buildRunLogDeleteCriteria({
    mode: runDeleteMode,
    type: runDeleteType,
    countInput: runDeleteCountInput,
    beforeDate: runDeleteBeforeDate,
  });
  const runDeleteSummary = runDeleteCriteria
    ? describeRunLogDeleteCriteria(runDeleteCriteria, runDeletePreviewCount ?? 0)
    : null;

  const groupedRuns = runs.reduce<Record<RunGroupKey, RunRecord[]>>((accumulator, run) => {
    const key = classifyRunGroup(run.kind);
    accumulator[key].push(run);
    return accumulator;
  }, { summary: [], chat: [], repo_search: [], planner: [], other: [] });
  const isRepoSearchRunSelected = selectedRunDetail
    ? classifyRunGroup(selectedRunDetail.run.kind) === 'repo_search'
    : false;
  const repoSearchChatSteps = selectedRunDetail ? buildRepoSearchChatSteps(selectedRunDetail.events) : [];

  const cacheRef = deps.runsCacheResetRef;

  useEffect(() => {
    let cancelled = false;
    async function refreshRuns() {
      if (!cacheRef.current.loaded) {
        setRunsLoading(true);
      }
      setRunsError(null);
      try {
        const hasSearch = search.trim().length > 0;
        const hasKindFilter = kindFilter.trim().length > 0;
        const hasStatusFilter = statusFilter.trim().length > 0;
        const usePerGroupCap = !hasSearch && !hasKindFilter && !hasStatusFilter;
        const response = await getRuns(search, kindFilter, statusFilter, {
          initial: usePerGroupCap,
          limitPerGroup: 20,
        });
        if (!cancelled) {
          const nextSignature = buildRunsSignature(response.runs);
          if (cacheRef.current.signature !== nextSignature) {
            cacheRef.current = { signature: nextSignature, loaded: cacheRef.current.loaded };
            setRuns(response.runs);
          }
          cacheRef.current = { signature: cacheRef.current.signature, loaded: true };
        }
      } catch (error) {
        if (!cancelled) {
          setRunsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setRunsLoading(false);
        }
      }
    }
    void refreshRuns();
    return () => { cancelled = true; };
  }, [search, kindFilter, statusFilter, deps.refreshToken]);

  useEffect(() => {
    if (!showRunDeleteModal) {
      return;
    }
    if (!runDeleteCriteria) {
      setRunDeletePreviewCount(null);
      setRunDeletePreviewBusy(false);
      setRunDeleteError(null);
      return;
    }
    let cancelled = false;
    setRunDeletePreviewBusy(true);
    setRunDeletePreviewCount(null);
    setRunDeleteError(null);
    void previewRunLogDelete(runDeleteCriteria)
      .then((response) => {
        if (!cancelled) {
          setRunDeletePreviewCount(response.matchCount);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRunDeletePreviewCount(null);
          setRunDeleteError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunDeletePreviewBusy(false);
        }
      });
    return () => { cancelled = true; };
  }, [showRunDeleteModal, runDeleteMode, runDeleteType, runDeleteCountInput, runDeleteBeforeDate]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      return;
    }
    let cancelled = false;
    void getRunDetail(selectedRunId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedRunDetail(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRunsError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  function openRunDeleteModal(): void {
    setRunDeleteMode('count');
    setRunDeleteType(kindFilter || 'all');
    setRunDeleteCountInput('25');
    setRunDeleteBeforeDate('');
    setRunDeletePreviewCount(null);
    setRunDeletePreviewBusy(false);
    setRunDeleteBusy(false);
    setRunDeleteError(null);
    setShowRunDeleteModal(true);
  }

  function closeRunDeleteModal(): void {
    if (runDeleteBusy) {
      return;
    }
    setShowRunDeleteModal(false);
    setRunDeleteError(null);
    setRunDeletePreviewBusy(false);
  }

  async function handleConfirmRunDelete(): Promise<void> {
    if (!runDeleteCriteria || runDeleteBusy) {
      return;
    }
    setRunDeleteBusy(true);
    setRunDeleteError(null);
    try {
      const response = await deleteRunLogs(runDeleteCriteria);
      const deletedIds = new Set(response.deletedRunIds);
      if (deletedIds.size > 0) {
        setRuns((previous) => previous.filter((run) => !deletedIds.has(run.id)));
      }
      if (selectedRunId && deletedIds.has(selectedRunId)) {
        setSelectedRunId('');
        setSelectedRunDetail(null);
      }
      deps.requestDashboardDataRefresh();
      setShowRunDeleteModal(false);
      deps.enqueueToast('warning', response.deletedCount > 0 ? `${runDeleteSummary || 'Deleted logs'}.` : 'No logs matched the selected criteria.');
    } catch (error) {
      setRunDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunDeleteBusy(false);
    }
  }

  async function refreshSelectedRunDetail(): Promise<void> {
    if (!selectedRunId) {
      return;
    }
    const detail = await getRunDetail(selectedRunId);
    setSelectedRunDetail(detail);
  }

  const tabProps: RunsTabProps = {
    search,
    statusFilter,
    kindFilter,
    runsLoading,
    runsError,
    groupedRuns,
    selectedRunId,
    selectedRunDetail,
    isRepoSearchRunSelected,
    repoSearchSimpleFlow,
    repoSearchChatSteps,
    onChangeSearch: setSearch,
    onOpenRunDeleteModal: openRunDeleteModal,
    onChangeStatusFilter: setStatusFilter,
    onToggleKindFilter: (value) => setKindFilter((previous) => toggleRunLogTypeFilter(previous, value)),
    onSelectRun: setSelectedRunId,
    onChangeRepoSearchSimpleFlow: setRepoSearchSimpleFlow,
  };

  const runDelete: RunDeleteController = {
    showModal: showRunDeleteModal,
    mode: runDeleteMode,
    type: runDeleteType,
    countInput: runDeleteCountInput,
    beforeDate: runDeleteBeforeDate,
    previewCount: runDeletePreviewCount,
    previewBusy: runDeletePreviewBusy,
    busy: runDeleteBusy,
    error: runDeleteError,
    summary: runDeleteSummary,
    hasCriteria: runDeleteCriteria !== null,
    setMode: setRunDeleteMode,
    setType: setRunDeleteType,
    setCountInput: setRunDeleteCountInput,
    setBeforeDate: setRunDeleteBeforeDate,
    open: openRunDeleteModal,
    close: closeRunDeleteModal,
    confirm: handleConfirmRunDelete,
  };

  return { tabProps, runDelete, search, kindFilter, statusFilter, selectedRunId, refreshSelectedRunDetail };
}
