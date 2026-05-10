import { createContext, useContext } from 'react';
import type { AnchorName } from './anchors';

/**
 * Maps each anchor name to the live host DOM element rendered by
 * `LayoutProvider`. `<Slot>` reads this via context and `createPortal`s
 * its children into the matching host.
 *
 * `null` entries are valid — they mean the host hasn't mounted yet
 * (StrictMode double-invoke window).
 */
export type AnchorElementMap = Partial<Record<AnchorName, HTMLElement | null>>;

export const LayoutContext = createContext<AnchorElementMap | null>(null);

export function useLayout(): AnchorElementMap {
  const ctx = useContext(LayoutContext);
  if (!ctx) {
    throw new Error('useLayout() must be used inside <LayoutProvider>');
  }
  return ctx;
}
