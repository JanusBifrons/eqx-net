/**
 * The who-hex honeycomb (selection HUD S5): what the left strip draws in
 * Command while own ships are selected. One pointy-top hex per ship type
 * (type icon + "×N"); tapping a hex keeps only that type selected
 * (`keepOnlyKind`, through the renderer, which owns the selection). More than
 * {@link WHO_HEX_MAX} types: the last slot is "?" with "+N" (the ships in the
 * remaining types), and tapping it opens the full list in the Fleet orders
 * panel (`rightPanel='orders'`).
 *
 * Grouping is `fleet/fleetView.ts` (`groupMirrorSelection` / `capKindGroups`),
 * read from the render mirror when the selection changes; nothing per frame.
 *
 * Layout: ONE connected honeycomb (owner 2026-11-27: "the select hexes aren't
 * connected and should be"): two hexes per row, odd rows shifted half a hex so
 * they interlock, neighbours sharing edges with no gap. Placed with the core
 * hex projection (`axialToPixel`, odd-r offset rows) at the tile's own size
 * (circumradius `HUD.hex.h / 2`): pitch = one hex width across, 3/4 of a hex
 * height down. The cells' boxes overlap, so only the hex-clipped button takes
 * pointer events (as in the do-hexes host); a shared edge never steals a tap. It sits in
 * the `left-strip` anchor, so the strip's fit (`leftStripFit.ts`) keeps it
 * under the mode switch and on screen. Slides out to the left while a right
 * panel is open, like the strip.
 */
import type { CSSProperties, ReactElement } from 'react';
import { axialToPixel } from '@core/hex/hex';
import { EqxIcon, EqxIconButton } from '../../ui/index.js';
import { HUD } from '../hud/tokens';
import type { KindGroup } from '../fleet/fleetView';

/** Hexes before the "?" overflow takes the last slot (owner 2026-11-27). */
export const WHO_HEX_MAX = 5;
/** Hexes per honeycomb row. */
const PER_ROW = 2;
/** The tile's circumradius: `HUD.hex` is a pointy-top hexagon h tall. */
const HEX_SIZE = HUD.hex.h / 2;
/** Only the hex-clipped button takes taps, and only while the honeycomb is shown. */
const CELL_CLASS = 'eqx-who-hex-cell';
const CELL_CSS = `[data-testid="who-hexes"][data-open="true"] .${CELL_CLASS} button { pointer-events: auto; }`;

/** Top-left px offset of slot `i` in a {@link PER_ROW}-wide honeycomb of
 *  `HUD.hex` tiles (pure; unit-tested). Odd rows are shifted half a hex right. */
export function whoHexSlot(i: number): { x: number; y: number } {
  const row = Math.floor(i / PER_ROW);
  const col = i % PER_ROW;
  // Odd-r offset -> axial: q = col - floor(row / 2).
  const p = axialToPixel({ q: col - Math.floor(row / 2), r: row }, HEX_SIZE);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** The honeycomb's box for `n` slots, px (pure). */
export function whoHexBox(n: number): { w: number; h: number } {
  if (n <= 0) return { w: 0, h: 0 };
  let w = 0;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const s = whoHexSlot(i);
    w = Math.max(w, s.x + HUD.hex.w);
    h = Math.max(h, s.y + HUD.hex.h);
  }
  return { w, h };
}

/** Characters that fit across a hex under the icon (`HUD.hex.w`, the hex word font). */
export const WHO_HEX_WORD_CHARS = 10;

/**
 * The hex's word: the short type name plus the count ("Fighter ×2"), within
 * {@link WHO_HEX_WORD_CHARS}. A long multi-word name keeps its last word (the
 * hull: "Mining Barge" -> "Barge"); still too long, it is cut with "…".
 * The full name stays in the tooltip (pure; unit-tested).
 */
export function whoHexWord(name: string, count: number, max = WHO_HEX_WORD_CHARS): string {
  const suffix = ` ×${count}`;
  const room = Math.max(1, max - suffix.length);
  let short = name.trim() || 'Ship';
  if (short.length > room) {
    const words = short.split(/\s+/);
    if (words.length > 1) short = words[words.length - 1]!;
  }
  if (short.length > room) short = `${short.slice(0, Math.max(1, room - 1))}…`;
  return short + suffix;
}

/** Test-id slug for a kind (`''` = not known yet). */
export function whoHexTestId(kind: string): string {
  return `who-hex-${kind === '' ? 'unknown' : kind}`;
}

const QUESTION = (
  <span aria-hidden style={{ fontFamily: HUD.font.label, fontSize: HUD.hex.icon, fontWeight: 700, lineHeight: 1 }}>?</span>
);

interface Props {
  shown: readonly KindGroup[];
  overflowKinds: readonly KindGroup[];
  overflowCount: number;
  /** Every selected ship (the hexes' total). */
  total: number;
  /** The focused id: its type's hex is lit. */
  focusId: string | null;
  open: boolean;
  onKeep: (group: KindGroup) => void;
  onMore: () => void;
}

export function WhoHexes({ shown, overflowKinds, overflowCount, total, focusId, open, onKeep, onMore }: Props): ReactElement {
  const slots = shown.length + (overflowKinds.length > 0 ? 1 : 0);
  const box = whoHexBox(slots);
  const style: CSSProperties = {
    position: 'relative',
    width: box.w,
    height: box.h,
    marginLeft: 'calc(8px + env(safe-area-inset-left, 0px))',
    pointerEvents: 'none',
    transform: open ? 'none' : 'translateX(-120%)',
    opacity: open ? 1 : 0,
    transition: `transform ${open ? HUD.motion.slideInMs : HUD.motion.slideOutMs}ms ${HUD.motion.slideEasing}, opacity ${HUD.motion.slideOutMs}ms`,
  };
  const at = (i: number): CSSProperties => {
    const s = whoHexSlot(i);
    return { position: 'absolute', left: s.x, top: s.y, width: HUD.hex.w, height: HUD.hex.h, pointerEvents: 'none' };
  };
  const moreNames = overflowKinds.map((g) => `${g.displayName} ×${g.count}`).join(', ');
  return (
    <div role="toolbar" aria-label="Selected ship types" data-testid="who-hexes" data-open={String(open)}
      data-count={total} data-kinds={shown.length + overflowKinds.length} style={style}>
      <style>{CELL_CSS}</style>
      {shown.map((g, i) => (
        <div key={g.kind || 'unknown'} className={CELL_CLASS} style={at(i)}>
          <EqxIconButton variant="hex" tone="neutral" icon={<EqxIcon name="ship" />} word={whoHexWord(g.displayName, g.count)}
            tooltip={`${g.displayName} ×${g.count}`} lit={focusId !== null && g.ids.includes(focusId)}
            onClick={() => onKeep(g)} data-testid={whoHexTestId(g.kind)} />
        </div>
      ))}
      {overflowKinds.length > 0 && (
        <div key="more" className={CELL_CLASS} style={at(shown.length)}>
          <EqxIconButton variant="hex" tone="neutral" icon={QUESTION} word={`+${overflowCount}`}
            tooltip={`${overflowCount} more: ${moreNames}`} onClick={onMore} data-testid="who-hex-more" />
        </div>
      )}
    </div>
  );
}
