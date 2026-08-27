import React from 'react';
import { getToolActivityLabel, type ToolActivityGroup } from '../lib/tool-activity-ring';

export function ToolActivityRow({ group }: { group: ToolActivityGroup }) {
  const tone = group.state === 'failed' ? 'tool-activity-failed' : 'tool-activity-neutral';
  return (
    <div className={`tool-activity-row ${tone}`} role="status">
      {getToolActivityLabel(group)}
    </div>
  );
}
