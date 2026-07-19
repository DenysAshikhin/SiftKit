import { useEffect, useState } from 'react';
import { getDashboardView } from './dashboard-route';
import { RunDeleteModal } from './components/RunDeleteModal';
import { SettingsMockupPage } from './settings-mockup';
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

const TAB_KEYS = ['runs', 'metrics', 'benchmark', 'chat', 'settings'] as const;
type TabKey = (typeof TAB_KEYS)[number];
function isTabKey(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.some((key) => key === value);
}

export function App() {
  const dashboardView = getDashboardView(window.location.pathname);
  return dashboardView === 'mockup' ? <SettingsMockupPage /> : <DashboardApp />;
}

function DashboardApp() {
  const params = readSearchParams();
  const tabParam = params.get('tab');
  const [tab, setTab] = useState<TabKey>(isTabKey(tabParam) ? tabParam : 'runs');
  const [menuOpen, setMenuOpen] = useState(false);

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
    onSwitchTab: (nextTab) => { setTab(nextTab); setMenuOpen(false); },
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

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) {
        return;
      }
      if (target.closest('.topbar-menu')) {
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-menu">
          <button
            type="button"
            className="hamburger-button"
            aria-label="Open sections menu"
            onClick={() => setMenuOpen((previous) => !previous)}
          >
            <span />
            <span />
            <span />
          </button>
          {menuOpen ? (
            <div className="menu-popover">
              <button
                className={tab === 'runs' ? 'active' : ''}
                onClick={() => settings.onRequestTabChange('runs')}
              >
                Logs
              </button>
              <button
                className={tab === 'metrics' ? 'active' : ''}
                onClick={() => settings.onRequestTabChange('metrics')}
              >
                Metrics
              </button>
              <button
                className={tab === 'benchmark' ? 'active' : ''}
                onClick={() => settings.onRequestTabChange('benchmark')}
              >
                Benchmark
              </button>
              <button
                className={tab === 'chat' ? 'active' : ''}
                onClick={() => settings.onRequestTabChange('chat')}
              >
                Chat
              </button>
              <button
                className={tab === 'settings' ? 'active' : ''}
                onClick={() => settings.onRequestTabChange('settings')}
              >
                Settings
              </button>
            </div>
          ) : null}
        </div>
        <h1>SiftKit Local Dashboard</h1>
        <button
          type="button"
          className="topbar-refresh-button"
          onClick={refresh.requestDashboardDataRefresh}
          aria-label="Refresh dashboard data"
        >
          Refresh data
        </button>
      </header>

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

      {tab === 'runs' && (
        <RunsTab {...runs.tabProps} />
      )}

      {tab === 'metrics' && (
        <>
          {metricsController.metricsError && <p className="error">{metricsController.metricsError}</p>}
          <MetricsTab {...metricsController.tabProps} />
        </>
      )}
      {tab === 'benchmark' && (
        <BenchmarkTab {...benchmark.tabProps} />
      )}
      {tab === 'settings' && (
        <SettingsTab {...settings.tabProps} />
      )}

      {tab === 'chat' && (
        <ChatTab {...chat.tabProps} />
      )}
    </main>
  );
}
