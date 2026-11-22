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
    panel: 'rgba(6,10,20,0.72)',
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
    /** Window paper (Hangar, menus): near-black blue. */
    paper: '#070b15',
    /** A tile / picture well inside a window. */
    cell: '#0b1222',
    /** Stronger edge for tiles and buttons. */
    edge2: 'rgba(160,200,255,0.28)',
    /** Capital tier edge (blue) and owned-hull edge (gold). */
    tier1: 'rgba(74,168,255,0.6)',
    tier2: 'rgba(255,200,58,0.7)',
    /** MUI primary (buttons, focus, game-dialog titles): signal green. */
    brand: '#00ff88',
    /** Page background behind everything (MUI background.default). */
    appBg: '#05070f',
    /** Default MUI Paper (menus, drawers without their own paper). */
    appPaper: '#0d1117',
    /** Game dialog (ShipDetail, Upgrade, loot): opaque navy paper. */
    dialogBg: '#0c1020',
    /** Game dialog thin slate edge. */
    dialogEdge: '#2a2f40',
    /** Game dialog body text. */
    dialogInk: '#ccc',
    /** Side panel paper (right dock / bottom sheet). */
    sidePanelBg: 'rgba(8,12,24,0.98)',
    /** Side panel text. */
    sidePanelInk: '#dffff0',
    /** Side panel edge. */
    sidePanelEdge: '#2a3550',
  },
  /** Minimum invisible touch target (Apple HIG / Material: 44–48 px). */
  touchMin: 44,
  /** Layout sizes (UI language plan B3), px. */
  size: {
    /** Right rail width on a phone. */
    railPhone: 48,
    /** Right rail width on desktop. */
    railDesktop: 56,
    /** The one icon-button size for the rail and the left strip (>= touchMin). */
    iconButton: 44,
    /** EqxIcon glyph sizes; medium is the glyph inside an EqxIconButton. */
    iconGlyph: { small: 18, medium: 24, large: 32 },
    /** EqxIcon line weight (mock-ups: 2 in strips and panels, 1.7 on the rail). */
    iconStroke: { regular: 2, light: 1.7 },
  },
  /** Motion (UI language plan B3). Honour prefers-reduced-motion at the call site. */
  motion: {
    /** Panel / strip slide in, ms (MUI enteringScreen). */
    slideInMs: 225,
    /** Panel / strip slide out, ms (MUI leavingScreen). */
    slideOutMs: 195,
    /** Slide easing (MUI easeOut). */
    slideEasing: 'cubic-bezier(0.0, 0, 0.2, 1)',
    /** A dragged panel snapping back to docked, ms. */
    snapBackMs: 160,
  },
} as const;

export function hullColor(pct: number): string {
  if (pct > 50) return HUD.color.hullOk;
  if (pct > 25) return HUD.color.hullWarn;
  return HUD.color.hullCrit;
}
