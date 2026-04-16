import { useEffect, useState } from 'react';

import {
  readHiddenSeriesState,
  sanitizeHiddenSeriesState,
  writeHiddenSeriesState,
  type KeyValueStore,
} from '../metric-graph-persistence';
import { getGraphHoverIndex } from '../metrics-view';
import { formatNumber } from '../lib/format';

export type SeriesPoint = {
  label: string;
  value: number;
};

export type InteractiveSeries = {
  key: string;
  title: string;
  unit: string;
  color: string;
  points: SeriesPoint[];
};

export type InteractiveGraphProps = {
  storageId: string;
  title: string;
  series: InteractiveSeries[];
  height?: number;
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

function buildLinePathFromValues(values: number[], width: number, height: number, maxValue: number): string {
  if (values.length === 0) {
    return '';
  }
  const safeMax = Math.max(1, maxValue);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - ((Math.max(0, value) / safeMax) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

export function InteractiveGraph({ storageId, title, series, height = 180 }: InteractiveGraphProps) {
  const width = 520;
  const seriesKeys = series.map((item) => item.key);
  const storage = getBrowserStorage();
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Record<string, boolean>>(() => (
    readHiddenSeriesState(storage, storageId, seriesKeys)
  ));
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const pointCount = series.reduce((max, item) => Math.max(max, item.points.length), 0);
  const visibleSeries = series.filter((item) => !hiddenSeriesKeys[item.key]);
  const maxValue = Math.max(
    1,
    ...visibleSeries.flatMap((item) => item.points.map((point) => point.value)),
  );
  const clampedHoverIndex = hoverIndex === null || pointCount <= 0
    ? null
    : Math.max(0, Math.min(pointCount - 1, hoverIndex));
  const hoverLabel = clampedHoverIndex === null
    ? null
    : (series.find((item) => item.points[clampedHoverIndex])?.points[clampedHoverIndex]?.label || null);

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
    <article className="interactive-graph">
      <header className="interactive-graph-header">
        <h3>{title}</h3>
        <span>{pointCount} points</span>
      </header>
      <div className="graph-legend">
        {series.map((item) => {
          const isHidden = Boolean(hiddenSeriesKeys[item.key]);
          const latest = item.points.length > 0 ? item.points[item.points.length - 1] : null;
          return (
            <button
              key={item.key}
              type="button"
              className={`graph-legend-chip ${isHidden ? 'off' : 'on'}`}
              onClick={() => {
                setHiddenSeriesKeys((previous) => ({
                  ...previous,
                  [item.key]: !previous[item.key],
                }));
              }}
            >
              <span className="dot" style={{ backgroundColor: item.color }} />
              {item.title}: {latest ? `${formatNumber(latest.value)} ${item.unit}` : '-'}
            </button>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <rect className="graph-frame" x="0" y="0" width={width} height={height} rx="8" ry="8" />
        {visibleSeries.map((item) => {
          const values = item.points.map((point) => point.value);
          const path = buildLinePathFromValues(values, width, height, maxValue);
          if (!path) {
            return null;
          }
          return (
            <path
              key={item.key}
              d={path}
              stroke={item.color}
              strokeWidth="2.4"
              fill="none"
            />
          );
        })}
        {clampedHoverIndex !== null && pointCount > 1 ? (
          <line
            x1={(clampedHoverIndex / (pointCount - 1)) * width}
            y1={0}
            x2={(clampedHoverIndex / (pointCount - 1)) * width}
            y2={height}
            stroke="#7f96ad88"
            strokeWidth="1"
          />
        ) : null}
        <rect
          className="graph-hover-layer"
          x="0"
          y="0"
          width={width}
          height={height}
          rx="8"
          ry="8"
          fill="transparent"
          pointerEvents="all"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setHoverIndex(getGraphHoverIndex(pointCount, event.clientX - box.left, box.width));
          }}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>
      {hoverLabel ? (
        <div className="graph-tooltip">
          <strong>{hoverLabel}</strong>
          {visibleSeries.map((item) => {
            const point = item.points[clampedHoverIndex ?? 0];
            return (
              <span key={`${item.key}-hover`}>
                {item.title}: {point ? `${formatNumber(point.value)} ${item.unit}` : '-'}
              </span>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
