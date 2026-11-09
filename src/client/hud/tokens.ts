/**
 * HUD design tokens (exp/hud-mobile-first). One place for the colours, fonts
 * and sizes the experimental piloting HUDs share, so the drawer / menus can
 * adopt the same language later.
 *
 * Colour language:
 *  - AUTO   (turrets choose targets)  → cyan
 *  - MANUAL (you aim / hold fire)     → amber
 *  - shield cyan-blue, hull green→amber→red, energy gold, credits pale gold.
 */
export const HUD = {
  font: {
    /** Labels, captions, buttons. Condensed sci-fi sans. */
    label: '"Chakra Petch", system-ui, sans-serif',
    /** Every number (credits, %, grid). Tabular so values don't jiggle. */
    num: '"JetBrains Mono", ui-monospace, monospace',
  },
  color: {
    ink: '#dfe8f5',
    inkDim: 'rgba(223,232,245,0.55)',
    inkFaint: 'rgba(223,232,245,0.32)',
    panel: 'rgba(6,10,20,0.55)',
    panelEdge: 'rgba(160,200,255,0.16)',
    auto: '#34d8ff',
    autoGlow: 'rgba(52,216,255,0.45)',
    manual: '#ffb02e',
    manualGlow: 'rgba(255,176,46,0.5)',
    shield: '#36c8ff',
    hullOk: '#3ee68a',
    hullWarn: '#ffc23d',
    hullCrit: '#ff4d4d',
    energy: '#ffc23d',
    credits: '#ffd76a',
    boost: '#ff8c3a',
    danger: '#ff4d6a',
  },
  /** Minimum invisible touch target (Apple HIG / Material: 44–48 px). */
  touchMin: 44,
} as const;

export function hullColor(pct: number): string {
  if (pct > 50) return HUD.color.hullOk;
  if (pct > 25) return HUD.color.hullWarn;
  return HUD.color.hullCrit;
}
