import { useState } from 'react';

export type ToastLevel = 'info' | 'warning' | 'error';
export type ToastMessage = { id: string; level: ToastLevel; text: string };
export type ToastState = { toasts: ToastMessage[]; nextSeq: number };

const MAX_TOASTS = 5;
export const TOAST_DISMISS_MS = 9000;

export function addToast(state: ToastState, level: ToastLevel, text: string): ToastState {
  const normalized = String(text || '').trim();
  if (!normalized) return state;
  const id = `${state.nextSeq}`;
  const toasts = [...state.toasts, { id, level, text: normalized }].slice(-MAX_TOASTS);
  return { toasts, nextSeq: state.nextSeq + 1 };
}
export function removeToast(state: ToastState, id: string): ToastState {
  return { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
}

export function useToasts() {
  const [state, setState] = useState<ToastState>({ toasts: [], nextSeq: 0 });
  function enqueueToast(level: ToastLevel, text: string): void {
    setState((prev) => {
      const next = addToast(prev, level, text);
      if (next === prev) return prev;
      const added = next.toasts[next.toasts.length - 1];
      if (added) window.setTimeout(() => setState((s) => removeToast(s, added.id)), TOAST_DISMISS_MS);
      return next;
    });
  }
  function dismissToast(id: string): void { setState((prev) => removeToast(prev, id)); }
  return { toasts: state.toasts, enqueueToast, dismissToast };
}
