import { useEffect, useRef, useState } from 'react';

import { toError } from '../../../src/lib/errors.ts';
import { VaultRequestError } from '../vault-api.ts';

export type AttachmentState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'image'; readonly url: string }
  | { readonly kind: 'removed' }
  | { readonly kind: 'failed'; readonly message: string };

/** Fetches an attachment once per target and holds it as an object URL until unmount or a new target. */
export function useAttachmentUrl(load: (target: string) => Promise<Blob>, target: string): AttachmentState {
  const [state, setState] = useState<AttachmentState>({ kind: 'loading' });
  // Callers rebuild `load` every render; only a new target should refetch.
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const blob = await latestLoad.current(target);
        if (!active) return;
        url = window.URL.createObjectURL(blob);
        setState({ kind: 'image', url });
      } catch (error) {
        if (!active) return;
        setState(error instanceof VaultRequestError && error.status === 404 ? { kind: 'removed' } : { kind: 'failed', message: toError(error).message });
      }
    })();
    return () => {
      active = false;
      if (url !== null) window.URL.revokeObjectURL(url);
    };
  }, [target]);
  return state;
}
