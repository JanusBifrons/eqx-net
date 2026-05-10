import { useMemo, useState, type ReactNode } from 'react';
import { ANCHOR_NAMES, ANCHOR_STYLES, type AnchorName } from './anchors';
import { LayoutContext, type AnchorElementMap } from './useLayout';

interface Props {
  children: ReactNode;
}

/**
 * Renders one fixed-position host div per anchor and exposes the live
 * element map via `LayoutContext`. Children call `<Slot anchor=...>` to
 * portal their content into the matching host.
 *
 * Orientation policy: portrait works by default. Entering fullscreen is the
 * only path that locks landscape, and that lock is initiated explicitly by
 * the user via `<FullscreenToggle>` — not reflexively on first touch.
 */
export function LayoutProvider({ children }: Props): JSX.Element {
  // Element map lives in state so context consumers re-render only when an
  // anchor mounts or unmounts. The ref callbacks are memoised per anchor so
  // React doesn't see a fresh callback every render (which would bounce
  // detach/attach in an infinite loop — see commit history).
  const [elementMap, setElementMap] = useState<AnchorElementMap>(() => {
    const out: AnchorElementMap = {};
    for (const name of ANCHOR_NAMES) out[name] = null;
    return out;
  });

  const setters = useMemo(() => {
    const out: Record<AnchorName, (el: HTMLDivElement | null) => void> = {} as Record<
      AnchorName,
      (el: HTMLDivElement | null) => void
    >;
    for (const name of ANCHOR_NAMES) {
      out[name] = (el: HTMLDivElement | null): void => {
        setElementMap((prev) => (prev[name] === el ? prev : { ...prev, [name]: el }));
      };
    }
    return out;
  }, []);

  return (
    <LayoutContext.Provider value={elementMap}>
      {children}
      {ANCHOR_NAMES.map((name) => (
        <div
          key={name}
          ref={setters[name]}
          data-anchor={name}
          data-testid={`slot-anchor-${name}`}
          style={ANCHOR_STYLES[name]}
        />
      ))}
    </LayoutContext.Provider>
  );
}
