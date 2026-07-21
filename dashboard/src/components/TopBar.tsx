import React from 'react';
import type { ReactNode } from 'react';

export function TopBar({ sectionTitle, actions }: { sectionTitle: string; actions?: ReactNode }) {
  return (
    <header className="top">
      <h1><span className="crumb">SiftKit /</span> <span>{sectionTitle}</span></h1>
      <div className="right">{actions}</div>
    </header>
  );
}
