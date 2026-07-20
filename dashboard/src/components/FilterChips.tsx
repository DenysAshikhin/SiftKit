import React from 'react';

export type FilterChipItem = { value: string; label: string; active: boolean };

export function FilterChips({ items, onToggle, className }: {
  items: readonly FilterChipItem[];
  onToggle(value: string): void;
  className?: string;
}) {
  return (
    <div className={className ? `chips ${className}` : 'chips'}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={item.active ? 'chip on' : 'chip'}
          aria-pressed={item.active}
          onClick={() => onToggle(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
