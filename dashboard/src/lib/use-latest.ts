import { useRef, type RefObject } from 'react';

/**
 * The current value of state, readable from an effect whose dependency array deliberately excludes
 * it. Assigning during render keeps the ref in step with the render that scheduled the effect, so
 * the effect reads the value that produced it rather than whatever the closure happened to capture.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}