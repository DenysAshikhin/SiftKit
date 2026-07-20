import React, { useEffect, useState } from 'react';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { RunDeleteModal } from './components/RunDeleteModal';
import { useToasts } from './hooks/useToasts';
import { useDashboardRefresh } from './hooks/useDashboardRefresh';
import { useRunsController } from './hooks/useRunsController';
import { useMetricsController } from './hooks/useMetricsController';
import { useBenchmarkController } from './hooks/useBenchmarkController';
import { useSettingsController } from './hooks/useSettingsController';
import { useChatController } from './hooks/useChatController';
import { readSearchParams, writeSearchParams } from './lib/format';
import { RunsTab } from './tabs/RunsTab';
import { MetricsTab } from './tabs/MetricsTab';
import { ChatTab } from './tabs/ChatTab';
import { SettingsTab } from './tabs/SettingsTab';
import { BenchmarkTab } from './tabs/BenchmarkTab';

export const TAB_KEYS = ['runs', 'metrics', 'benchmark', 'chat', 'settings'] as const;
export type TabKey = (typeof TAB_KEYS)[number];
function isTabKey(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.some((key) => key === value);
}

const SECTION_TITLES: Record<TabKey, string> = {
  runs: 'Logs',
  metrics: 'Metrics',
  benchmark: 'Benchmark',
  chat: 'Chat',
  settings: 'Settings',
};

export function App() {
  const params = readSearchParams();
  const tabParam = params.get('tab');
  const [tab, setTab] = useState<TabKey>(isTabKey(tabParam) ? tabParam : 'runs');

  const { toasts, enqueueToast, dismissToast } = useToasts();
  const refresh = useDashboardRefresh();
  const runs = useRunsController({
    enqueueToast,
    refreshToken: refresh.refreshToken,
    runsCacheResetRef: refresh.runsCacheResetRef,
    requestDashboardDataRefresh: refresh.requestDashboardDataRefresh,
  });

  const metricsController = useMetricsController({ refreshToken: refresh.refreshToken, tab });

  const settings = useSettingsController({
    enqueueToast,
    requestDashboardDataRefresh: refresh.requestDashboardDataRefresh,
    tab,
    webSearchUsage: metricsController.webSearchUsage,
    webSearchQuota: metricsController.webSearchQuota,
    onSwitchTab: (nextTab) => { setTab(nextTab); },
  });
  const dashboardConfig = settings.dashboardConfig;

  const benchmark = useBenchmarkController({
    enqueueToast,
    refreshToken: refresh.refreshToken,
    requestDashboardDataRefresh: refresh.requestDashboardDataRefresh,
    tab,
    managedPresets: dashboardConfig?.Server.ModelPresets.Presets ?? [],
  });

  const chat = useChatController({
    refreshToken: refresh.refreshToken,
    dashboardConfig,
    maintainPerStepThinkingForCurrentPreset: settings.maintainPerStepThinkingForCurrentPreset,
    requestDashboardDataRefresh: refresh.requestDashboardDataRefresh,
    refreshSelectedRunDetail: runs.refreshSelectedRunDetail,
  });

  useEffect(() => {
    writeSearchParams({
      tab,
      search: runs.search || null,
      kind: runs.kindFilter || null,
      status: runs.statusFilter || null,
      run: runs.selectedRunId || null,
      session: chat.selectedSessionId || null,
      benchmarkSession: benchmark.selectedBenchmarkSessionId || null,
    });
  }, [tab, runs.search, runs.kindFilter, runs.statusFilter, runs.selectedRunId, chat.selectedSessionId, benchmark.selectedBenchmarkSessionId]);

  const serverHealthy = !metricsController.metricsError;

  const refreshButton = (
    <button type="button" className="ghost-btn acc" onClick={refresh.requestDashboardDataRefresh}>
      ⟳ Refresh
    </button>
  );
  const topBarActions = tab === 'runs' ? (
    <>
      <button type="button" className="ghost-btn" onClick={runs.tabProps.onOpenRunDeleteModal}>
        Delete logs
      </button>
      {refreshButton}
    </>
  ) : refreshButton;

  return (
    <div className="app">
      <Rail activeTab={tab} serverHealthy={serverHealthy} onSelectTab={(next) => settings.onRequestTabChange(next)} />
      <div className="body">
        <TopBar sectionTitle={SECTION_TITLES[tab]} actions={topBarActions} />

        {toasts.length > 0 && (
          <section className="toast-stack" aria-live="polite" aria-atomic="true">
            {toasts.map((toast) => (
              <article key={toast.id} className={`toast ${toast.level}`}>
                <span>{toast.text}</span>
                <button
                  type="button"
                  className="toast-dismiss"
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss notification"
                >
                  x
                </button>
              </article>
            ))}
          </section>
        )}

        {settings.confirm.show && (
          <section className="settings-live-modal-backdrop" role="presentation">
            <div className="settings-live-modal" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
              <h2 id="settings-confirm-title">Unsaved settings changes</h2>
              <p className="hint">Save the current settings draft before continuing, discard the unsaved changes, or cancel and stay on this section.</p>
              <div className="settings-live-modal-actions">
                <button type="button" onClick={() => { void settings.confirm.onSave(); }} disabled={settings.confirm.actionBusy}>
                  {settings.confirm.saving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={settings.confirm.onDiscard} disabled={settings.confirm.actionBusy}>
                  Discard
                </button>
                <button type="button" onClick={settings.confirm.onCancel} disabled={settings.confirm.actionBusy}>
                  Cancel
                </button>
              </div>
            </div>
          </section>
        )}

        {settings.restartFailureModal && (
          <section className="settings-live-modal-backdrop" role="presentation">
            <div className="settings-live-modal" role="dialog" aria-modal="true" aria-labelledby="settings-restart-failure-title">
              <h2 id="settings-restart-failure-title">{settings.restartFailureModal.title}</h2>
              <p>{settings.restartFailureModal.message}</p>
              <div className="settings-live-modal-actions">
                <button type="button" onClick={settings.closeRestartFailureModal} disabled={settings.confirm.actionBusy}>
                  Close
                </button>
              </div>
            </div>
          </section>
        )}

        {runs.runDelete.showModal && <RunDeleteModal runDelete={runs.runDelete} />}

        <div className="view on">
          {tab === 'runs' && <RunsTab {...runs.tabProps} />}
          {tab === 'metrics' && (
            <>
              {metricsController.metricsError && <p className="error">{metricsController.metricsError}</p>}
              <MetricsTab {...metricsController.tabProps} />
            </>
          )}
          {tab === 'benchmark' && <BenchmarkTab {...benchmark.tabProps} />}
          {tab === 'settings' && <SettingsTab {...settings.tabProps} />}
          {tab === 'chat' && <ChatTab {...chat.tabProps} />}
        </div>
      </div>
    </div>
  );
}
