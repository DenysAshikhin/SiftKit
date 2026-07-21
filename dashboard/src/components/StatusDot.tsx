import React from 'react';

export type StatusTone = 'ok' | 'bad' | 'run';

export function statusTone(status: string): StatusTone {
  if (status === 'completed') { return 'ok'; }
  if (status === 'failed') { return 'bad'; }
  return 'run';
}

export function StatusDot({ status }: { status: string }) {
  return (
    <>
      <span className={`dot ${statusTone(status)}`} />
      {status}
    </>
  );
}
