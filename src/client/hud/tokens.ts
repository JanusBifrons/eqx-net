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
    sidePanelBg: 'rgba(8,12,24,0.97)',
    /** Side panel edge. */
    sidePanelEdge: '#2a3550',
    /** Dark text on a filled cyan / amber button (mock .btn.pri). */
    onAccent: '#021018',
  },
  /** Minimum invisible touch target (Apple HIG / Material: 44–48 px). */
  touchMin: 44,
  /** EqxSegmented in a panel (mock `.seg`): full width, equal segments. Sizes px. */
  segmented: {
    font: 13,
    radius: 5,
    padY: 6,
    padX: 2,
    minHeight: 36,
    /** Selected option (mock `.seg b.on`): cyan wash, cyan text. */
    selectedBg: 'rgba(52,216,255,0.2)',
    /** Selected option that differs from the applied value (mock `.seg b.chg`). */
    changedBg: 'rgba(255,176,46,0.2)',
  },
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
  /** EqxPanel layout (mock .ph/.pb/.pf, 1cqw = 9.15 px on a 915 px phone), px. */
  panel: {
    /** Header min height (4.6cqw). */
    headMinH: 42,
    /** Header / body / footer padding: 1cqw x 1.3cqw. */
    padY: 9,
    padX: 12,
    /** Body gap between rows (.9cqw). */
    bodyGap: 8,
    /** Header and footer gap (.8cqw). */
    rowGap: 7,
    /** Title size (1.5cqw). */
    titleSize: 14,
    /** The header ✕ / ← square (3cqw). */
    headBtn: 27,
    /** Control corner radius (.5cqw), also EqxButton. */
    radius: 5,
    /** Small button text (1.2cqw) and padding (.7cqw). */
    btnFont: 11,
    btnPad: 6,
    /** Disabled control opacity (mock .btn.off). */
    offOpacity: 0.35,
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
  /**
   * Left strip + status fly-out look (owner-approved mock .lbar / .ib / .flyo,
   * 1cqw = 9.15 px on a 915 px sideways phone). Px and colours.
   */
  strip: {
    /** Strip / fly-out box paper. */
    bg: 'rgba(8,12,24,0.97)',
    /** Tile / strip / separator edge (mock --edge2). */
    edge: 'rgba(160,200,255,0.3)',
    /** Tile well (mock --cell). */
    cell: '#0f1729',
    /** Icon on a filled green "ok" tile. */
    okInk: '#03140a',
    /** Edge of a red "no" (stop / cancel) tile. */
    noEdge: 'rgba(255,77,106,0.5)',
    /** Edge of a cyan status tile. */
    statusEdge: 'rgba(53,214,255,0.45)',
    /** Count badge text on the gold pill. */
    badgeInk: '#140c00',
    /** Square tile side (3.9cqw). */
    tile: 36,
    /** Tile corner radius (.6cqw). */
    tileRadius: 5,
    /** Line icon size inside a tile (2cqw). */
    icon: 18,
    /** Strip padding (.5cqw) and gap between tiles (.45cqw). */
    pad: 5,
    gap: 4,
    /** Strip right-hand corner radius (.8cqw); the left edge is docked square. */
    radius: 7,
    /** Separator side inset (.3cqw) and vertical margin (.15cqw). */
    sepInset: 3,
    sepMargin: 1,
    /** Count badge pill: side (1.6cqw), offset past the tile corner (.5cqw), font (.9cqw). */
    badge: 15,
    badgeOffset: 5,
    badgeFont: 8,
    /** Fly-out: gap from the tile (.8cqw), radius (.7cqw), gap between options (.5cqw). */
    flyOffset: 7,
    flyRadius: 6,
    flyGap: 5,
    /** Fly-out slide-in: distance (1cqw) and duration. */
    flyInPx: 9,
    flyInMs: 220,
  },
} as const;

export function hullColor(pct: number): string {
  if (pct > 50) return HUD.color.hullOk;
  if (pct > 25) return HUD.color.hullWarn;
  return HUD.color.hullCrit;
}
