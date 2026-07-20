import React from 'react';
import type { ReactNode } from 'react';
import type { TabKey } from '../App';

export type RailItem = { tab: TabKey; label: string; title: string; icon: ReactNode };

export const RAIL_ITEMS: readonly RailItem[] = [
  { tab: 'runs', label: 'Logs', title: 'Logs', icon: <path d="M3 5h14M3 10h14M3 15h9" /> },
  { tab: 'metrics', label: 'Metrics', title: 'Metrics', icon: <path d="M3 16l4-6 3 3 4-8 3 5" /> },
  {
    tab: 'benchmark', label: 'Bench', title: 'Benchmark',
    icon: <><circle cx="10" cy="11" r="7" /><path d="M10 11l4-4" /></>,
  },
  { tab: 'chat', label: 'Chat', title: 'Chat', icon: <path d="M3 4h14v9H8l-4 4v-4H3z" /> },
  {
    tab: 'settings', label: 'Settings', title: 'Settings',
    icon: <><path d="M4 6h12M4 10h12M4 14h12" /><circle cx="8" cy="6" r="1.6" /><circle cx="13" cy="10" r="1.6" /><circle cx="6" cy="14" r="1.6" /></>,
  },
];

export function Rail({ activeTab, serverHealthy, onSelectTab }: {
  activeTab: TabKey;
  serverHealthy: boolean;
  onSelectTab(tab: TabKey): void;
}) {
  return (
    <nav className="rail">
      <div className="logo">S</div>
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.tab}
          type="button"
          className={activeTab === item.tab ? 'on' : ''}
          title={item.title}
          aria-current={activeTab === item.tab ? 'page' : undefined}
          onClick={() => onSelectTab(item.tab)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">{item.icon}</svg>
          {item.label}
        </button>
      ))}
      <div className="spacer" />
      <div
        className={serverHealthy ? 'pulse' : 'pulse offline'}
        title={serverHealthy ? 'server healthy' : 'server unavailable'}
      />
    </nav>
  );
}
