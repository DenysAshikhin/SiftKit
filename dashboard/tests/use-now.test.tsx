import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from './react-test-environment.ts';
import { useNow } from '../src/hooks/useNow.ts';

afterEach(() => { vi.useRealTimers(); });

test('the clock ticks while live and stands still otherwise', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const { result, rerender } = renderHook(({ live }) => useNow(1000, live), { initialProps: { live: true } });
  assert.equal(result.current, 1_000);
  act(() => { vi.advanceTimersByTime(3_000); });
  assert.equal(result.current, 4_000);
  rerender({ live: false });
  act(() => { vi.advanceTimersByTime(5_000); });
  assert.equal(result.current, 4_000);
});
