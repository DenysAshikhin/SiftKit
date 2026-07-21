import React, { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import {
  readHiddenSeriesState,
  sanitizeHiddenSeriesState,
  writeHiddenSeriesState,
  type KeyValueStore,
} from '../metric-graph-persistence';

export type MetricSeriesPoint = {
  label: string;
  value: number;
};

export type MetricSeries = {
  key: string;
  title: string;
  unit: string;
  color: string;
  points: MetricSeriesPoint[];
};

export type MetricChartProps = {
  storageId: string;
  title: string;
  series: MetricSeries[];
  subtitle?: string;
  height?: number;
  storageOverride?: KeyValueStore;
};

function getBrowserStorage(): KeyValueStore | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sameHiddenSeriesState(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => left[key]).sort();
  const rightKeys = Object.keys(right).filter((key) => right[key]).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

export function MetricChart({ storageId, title, series, subtitle, height, storageOverride }: MetricChartProps) {
  const seriesKeys = series.map((item) => item.key);
  const storage = storageOverride ?? getBrowserStorage();
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Record<string, boolean>>(() => (
    readHiddenSeriesState(storage, storageId, seriesKeys)
  ));
  const visibleSeries = series.filter((item) => !hiddenSeriesKeys[item.key]);
  const pointCount = series.reduce((max, item) => Math.max(max, item.points.length), 0);
  const rows = Array.from({ length: pointCount }, (_, index) => {
    const row: Record<string, string | number> = {
      label: series.find((item) => item.points[index])?.points[index]?.label ?? '',
    };
    for (const item of series) {
      const point = item.points[index];
      if (point) {
        row[item.key] = point.value;
      }
    }
    return row;
  });

  useEffect(() => {
    setHiddenSeriesKeys((previous) => {
      const sanitized = sanitizeHiddenSeriesState(previous, seriesKeys);
      return sameHiddenSeriesState(previous, sanitized) ? previous : sanitized;
    });
  }, [storageId, seriesKeys.join('|')]);

  useEffect(() => {
    writeHiddenSeriesState(storage, storageId, hiddenSeriesKeys, seriesKeys);
  }, [hiddenSeriesKeys, storage, storageId, seriesKeys.join('|')]);

  return (
    <div className="graph-card">
      <h3>{title}</h3>
      {subtitle ? <div className="sub">{subtitle}</div> : null}
      <ResponsiveContainer width="100%" height={height ?? 220}>
        <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#1a2634" strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" stroke="#879bb0" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#223040' }} />
          <YAxis stroke="#879bb0" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            contentStyle={{ background: '#121a23', border: '1px solid #223040', borderRadius: 8, color: '#dfe9f3', fontSize: 12 }}
            labelStyle={{ color: '#879bb0' }}
          />
          {visibleSeries.map((item) => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.title}
              stroke={item.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="legend">
        {series.map((item) => {
          const isHidden = Boolean(hiddenSeriesKeys[item.key]);
          return (
            <button
              key={item.key}
              type="button"
              className={`graph-legend-chip ${isHidden ? 'off' : 'on'}`}
              onClick={() => {
                setHiddenSeriesKeys((previous) => ({ ...previous, [item.key]: !previous[item.key] }));
              }}
            >
              <i style={{ background: item.color }} />{item.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}
