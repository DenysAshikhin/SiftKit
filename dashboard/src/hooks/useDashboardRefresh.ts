import { useRef, useState } from 'react';

export type RunsCacheReset = { signature: string; loaded: boolean };

export function useDashboardRefresh() {
  const [refreshToken, setRefreshToken] = useState(0);
  const runsCacheResetRef = useRef<RunsCacheReset>({ signature: '', loaded: false });
  function requestDashboardDataRefresh(): void {
    runsCacheResetRef.current = { signature: '', loaded: false };
    setRefreshToken((previous) => previous + 1);
  }
  return { refreshToken, runsCacheResetRef, requestDashboardDataRefresh };
}
