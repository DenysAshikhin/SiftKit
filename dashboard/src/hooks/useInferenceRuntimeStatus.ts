import React from 'react';

import { getInferenceRuntimeStatus } from '../api';
import type { InferenceRuntimeDashboardStatus } from '@siftkit/contracts';

const POLL_DELAY_MS = 2000;

type ActiveRequest = {
  controller: AbortController;
  sequence: number;
};

export type InferenceRuntimeStatusResult = {
  status: InferenceRuntimeDashboardStatus | null;
  loading: boolean;
  error: string | null;
  refetch(): Promise<void>;
};

export function useInferenceRuntimeStatus(): InferenceRuntimeStatusResult {
  const [status, setStatus] = React.useState<InferenceRuntimeDashboardStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const activeRequestRef = React.useRef<ActiveRequest | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(false);
  const sequenceRef = React.useRef(0);
  const refetchAfterSettleRef = React.useRef(false);

  const clearTimer = React.useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const requestStatus = React.useCallback(async (): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    clearTimer();
    if (activeRequestRef.current !== null) {
      refetchAfterSettleRef.current = true;
      return;
    }

    const controller = new AbortController();
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    activeRequestRef.current = { controller, sequence };
    setLoading(true);
    try {
      const nextStatus = await getInferenceRuntimeStatus({ signal: controller.signal });
      const activeRequest = activeRequestRef.current;
      if (mountedRef.current && activeRequest?.sequence === sequence && !controller.signal.aborted) {
        setStatus(nextStatus);
        setError(null);
      }
    } catch (requestError) {
      const activeRequest = activeRequestRef.current;
      if (mountedRef.current && activeRequest?.sequence === sequence && !controller.signal.aborted) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      const activeRequest = activeRequestRef.current;
      if (!mountedRef.current || activeRequest?.sequence !== sequence) {
        return;
      }
      activeRequestRef.current = null;
      setLoading(false);
      if (refetchAfterSettleRef.current) {
        refetchAfterSettleRef.current = false;
        void requestStatus();
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void requestStatus();
      }, POLL_DELAY_MS);
    }
  }, [clearTimer]);

  React.useEffect(() => {
    mountedRef.current = true;
    void requestStatus();
    return () => {
      mountedRef.current = false;
      clearTimer();
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      refetchAfterSettleRef.current = false;
    };
  }, [clearTimer, requestStatus]);

  return {
    status,
    loading,
    error,
    refetch: requestStatus,
  };
}
