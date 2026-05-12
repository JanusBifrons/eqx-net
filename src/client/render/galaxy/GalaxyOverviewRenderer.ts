import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import {
  GALAXY_SECTORS,
  axialToPixel,
  isNeighbour,
  type GalaxySector,
} from '@core/galaxy/galaxy';

const HEX_SIZE = 78;
const PAD_WORLD = 240;
const COLOR_BG = 0x05070f;
const COLOR_HIGHLIGHT_FILL = 0x00ff88;
const COLOR_HIGHLIGHT_STROKE = 0x00ff88;
const COLOR_SELECTABLE_FILL = 0x0a3322;
const COLOR_SELECTABLE_STROKE = 0x1f7a4d;
const COLOR_LOCKED_FILL = 0x161a26;
const COLOR_LOCKED_STROKE = 0x2a2f40;
const COLOR_LABEL_ACTIVE = 0x00ff88;
const COLOR_LABEL_LOCKED = 0x9aa0b4;
const COLOR_RESUME = 0xffaa33;

export type GalaxyOverviewMode = 'spawn' | 'warp';

export interface LimboInfo {
  sectorKey: string;
}

export interface GalaxyOverviewInitOptions {
  mode: GalaxyOverviewMode;
  currentSectorKey: string | null;
  limbo: LimboInfo | null;
}

interface HexEntry {
  sector: GalaxySector;
  x: number;
  y: number;
  hex: Graphics;
  label: Text;
  resumeLabel: Text;
}

function hexVertices(size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

export class GalaxyOverviewRenderer {
  private app!: Application;
  private viewport!: Viewport;
  private edgeLayer!: Container;
  private hexLayer!: Container;
  private entries: HexEntry[] = [];
  private mode: GalaxyOverviewMode = 'spawn';
  private currentSectorKey: string | null = null;
  private limbo: LimboInfo | null = null;
  /** Late-bound — settable via {@link setOnPick} so Vite Fast Refresh can
   *  swap the callback when the wrapping React component is rebuilt
   *  without destroying the renderer instance. */
  private onPick: (sectorKey: string) => void;
  private resumePulsePhase = 0;
  private initialized = false;

  constructor(opts: { onPick: (sectorKey: string) => void }) {
    this.onPick = opts.onPick;
  }

  /** Replace the click callback in place. Called on every render of the
   *  wrapping React component so even a Fast-Refresh-preserved renderer
   *  always fires the latest closure. */
  setOnPick(cb: (sectorKey: string) => void): void {
    this.onPick = cb;
  }

  async init(rawContainer: unknown, opts: GalaxyOverviewInitOptions): Promise<void> {
    const container = rawContainer as HTMLElement;
    this.mode = opts.mode;
    this.currentSectorKey = opts.currentSectorKey;
    this.limbo = opts.limbo;

    this.app = new Application();
    await this.app.init({
      width: container.clientWidth || window.innerWidth,
      height: container.clientHeight || window.innerHeight,
      background: COLOR_BG,
      antialias: true,
      resolution: window.devicePixelRatio ?? 1,
      autoDensity: true,
    });
    // Ensure the canvas always fills its parent regardless of what Pixi's
    // `autoDensity` does to CSS sizing — that path can race with a parent
    // layout shift (e.g. the limbo pill appearing) and end up sizing the
    // canvas to the *previous* parent dims, which then either overflows or
    // collapses to 0 depending on the new parent's overflow rules. Raw
    // 100%/100% lets the browser handle filling the box and we just keep
    // the renderer's internal pixel buffer in sync via ResizeObserver.
    this.app.canvas.style.position = 'absolute';
    this.app.canvas.style.top = '0';
    this.app.canvas.style.left = '0';
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    this.app.canvas.style.display = 'block';
    container.appendChild(this.app.canvas);
    this.initialized = true;

    const positions = GALAXY_SECTORS.map((s) => ({ s, ...axialToPixel(s.hex, HEX_SIZE) }));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of positions) {
      if (p.x - HEX_SIZE < minX) minX = p.x - HEX_SIZE;
      if (p.x + HEX_SIZE > maxX) maxX = p.x + HEX_SIZE;
      if (p.y - HEX_SIZE < minY) minY = p.y - HEX_SIZE;
      if (p.y + HEX_SIZE > maxY) maxY = p.y + HEX_SIZE;
    }
    // worldWidth/Height feed the Viewport constructor so the renderer
    // knows the conceptual world size. Camera is unclamped (free pan,
    // see below) — this is just for the Viewport's internal bookkeeping.
    const worldWidth = maxX - minX + PAD_WORLD * 2;
    const worldHeight = maxY - minY + PAD_WORLD * 2;

    this.viewport = new Viewport({
      screenWidth: container.clientWidth || window.innerWidth,
      screenHeight: container.clientHeight || window.innerHeight,
      worldWidth,
      worldHeight,
      events: this.app.renderer.events,
    });
    this.app.stage.addChild(this.viewport);

    // No `clamp` — free pan. The earlier clamp+underflow combo produced
    // wildly inconsistent behaviour (clamp without underflow snapped at
    // zoom breakpoints; clamp WITH underflow hid the map entirely on this
    // screen size). Free pan lets the user wander; if they drift away,
    // they can wheel/pinch zoom out to reorient. clampZoom still bounds
    // the zoom range so they can't accidentally zoom to nothing.
    this.viewport
      .drag()
      .pinch()
      .wheel({ smooth: 4 })
      .clampZoom({ minScale: 0.4, maxScale: 4 });

    // Click handling at the viewport level. `clicked` fires only on a
    // press-and-release that is NOT a drag (pixi-viewport's own threshold
    // distinguishes the two). The handler hit-tests the click position
    // against each hex in world coords using a circle approximation —
    // good enough for the 7-sector graph where hexes are well-separated.
    this.viewport.on('clicked', ({ world }) => {
      for (const entry of this.entries) {
        const dx = world.x - entry.x;
        const dy = world.y - entry.y;
        if (Math.hypot(dx, dy) <= HEX_SIZE) {
          if (this.isSelectable(entry.sector)) this.onPick(entry.sector.key);
          return;
        }
      }
    });

    this.edgeLayer = new Container();
    this.hexLayer = new Container();
    this.viewport.addChild(this.edgeLayer);
    this.viewport.addChild(this.hexLayer);

    this.buildHexes(positions);

    const focal = this.currentSectorKey
      ? positions.find((p) => p.s.key === this.currentSectorKey)
      : null;
    if (focal) {
      this.viewport.moveCenter(focal.x, focal.y);
    } else {
      this.viewport.moveCenter((minX + maxX) / 2, (minY + maxY) / 2);
    }
    this.viewport.setZoom(0.7);

    this.app.ticker.add(this.tickPulse);

    const resize = (): void => {
      if (!this.initialized || !this.app?.renderer) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      // Skip transient 0-dim events (parent flex shifts during layout —
      // e.g. when the limbo pill appears between header and mountRef).
      // Falling back to window.innerWidth/Height here would resize the
      // renderer to wildly wrong dims and the next "real" resize would
      // race against a stale internal state.
      if (w <= 0 || h <= 0) return;
      this.app.renderer.resize(w, h);
      this.viewport.resize(w, h);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    window.visualViewport?.addEventListener('resize', resize);
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    (this.app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
    (this.app as unknown as Record<string, unknown>)['_resizeObserver'] = ro;
    requestAnimationFrame(resize);
  }

  setCurrentSector(key: string | null): void {
    if (this.currentSectorKey === key) return;
    this.currentSectorKey = key;
    if (this.initialized) this.repaint();
  }

  setLimbo(info: LimboInfo | null): void {
    this.limbo = info;
    if (this.initialized) this.repaint();
  }

  setMode(mode: GalaxyOverviewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.initialized) this.repaint();
  }

  destroy(): void {
    if (!this.initialized) return;
    this.initialized = false;
    // Tear down listeners & observers FIRST so nothing fires against a
    // partially-destroyed app/renderer mid-cleanup.
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) {
      try { ro.disconnect(); } catch { /* observer already gone */ }
    }
    try { this.app.ticker.remove(this.tickPulse); } catch { /* ticker already gone */ }

    // React unmounts the host Box from the DOM at the same time this
    // cleanup runs, so by the time Pixi tries `removeView`, the canvas's
    // parentNode may already be null. Detach it explicitly first to keep
    // Pixi's destroy on the happy path.
    const canvas = this.app.canvas;
    if (canvas?.parentNode) {
      try { canvas.parentNode.removeChild(canvas); } catch { /* already detached */ }
    }
    try {
      this.app.destroy(false, { children: true, texture: false, textureSource: false });
    } catch (err) {
      // Don't let a destroy failure poison sibling renderers (the gameplay
      // PixiRenderer remains alive on its own canvas after this one closes).
      console.error('[GalaxyOverviewRenderer] destroy failed', err);
    }
  }

  private isSelectable(sec: GalaxySector): boolean {
    if (this.limbo) return sec.key === this.limbo.sectorKey;
    if (this.mode === 'spawn') return true;
    if (!this.currentSectorKey) return false;
    return isNeighbour(this.currentSectorKey, sec.key);
  }

  private buildHexes(positions: ReadonlyArray<{ s: GalaxySector; x: number; y: number }>): void {
    for (const p of positions) {
      const hex = new Graphics();
      hex.x = p.x;
      hex.y = p.y;
      // `eventMode` on the hex graphic stays `static` for selectable hexes
      // (set in `repaint()`) so the browser shows the pointer cursor; we
      // do NOT attach down/up handlers here because pixi-viewport's drag
      // plugin captures pointer events at the canvas level and the hex's
      // own pointerup doesn't reliably fire. Click-vs-drag detection
      // happens at the viewport level via the `clicked` event below — it
      // fires only on a non-drag release, no thresholds to tune.
      this.hexLayer.addChild(hex);

      const label = new Text({
        text: p.s.name,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: 16,
          fontWeight: '700',
          fill: COLOR_LABEL_ACTIVE,
          align: 'center',
          letterSpacing: 1,
        }),
      });
      label.anchor.set(0.5);
      label.x = p.x;
      label.y = p.y - 4;
      this.hexLayer.addChild(label);

      const resumeLabel = new Text({
        text: 'RESUME',
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: 12,
          fontWeight: '700',
          fill: COLOR_RESUME,
          letterSpacing: 2,
        }),
      });
      resumeLabel.anchor.set(0.5);
      resumeLabel.x = p.x;
      resumeLabel.y = p.y + 18;
      resumeLabel.visible = false;
      this.hexLayer.addChild(resumeLabel);

      this.entries.push({ sector: p.s, x: p.x, y: p.y, hex, label, resumeLabel });
    }
    this.repaint();
  }

  private repaint(): void {
    // Guard against React prop-sync effects firing between the public
    // ctor setters and the layers being created inside init() (init is
    // async; this.entries / this.edgeLayer / this.hexLayer don't exist
    // until init's body finishes). Without this guard, a setCurrentSector
    // call from a useEffect mid-init would crash on `removeChildren`.
    if (!this.edgeLayer || !this.hexLayer || this.entries.length === 0) return;
    for (const entry of this.entries) {
      const { sector, hex, label, resumeLabel } = entry;
      const highlighted = sector.key === this.currentSectorKey;
      const selectable = this.isSelectable(sector);
      const isLimbo = this.limbo?.sectorKey === sector.key;

      // Three visual tiers, with mode awareness:
      //  - highlighted: the current sector (pulsing green highlight).
      //  - selectable:  filled green; reachable via tap.
      //  - informational (warp-mode only): drawn at full visibility but
      //    inert. Used when in-game, the player opens the overview from
      //    the sidebar — they get a global view of the galaxy with the
      //    current sector marked, neighbours tappable, and non-neighbours
      //    fully visible (not greyed) so the overview stays "global".
      //  - locked: stroke-only faint outline. Reserved for spawn-mode
      //    when limbo restricts selection; non-limbo sectors are locked.
      const informational = !selectable && this.mode === 'warp';

      let fillColor: number;
      let fillAlpha: number;
      let strokeColor: number;
      let strokeWidth: number;
      let strokeAlpha: number;
      if (highlighted) {
        fillColor = COLOR_HIGHLIGHT_FILL;
        fillAlpha = 0.35;
        strokeColor = COLOR_HIGHLIGHT_STROKE;
        strokeWidth = 3;
        strokeAlpha = 1;
      } else if (selectable) {
        fillColor = COLOR_SELECTABLE_FILL;
        fillAlpha = 0.7;
        strokeColor = COLOR_SELECTABLE_STROKE;
        strokeWidth = 2;
        strokeAlpha = 1;
      } else if (informational) {
        // Subtle but readable: same palette as selectable, slightly dimmer
        // and thinner stroke so the eye still picks out the tappable hexes
        // without the non-neighbours feeling punished.
        fillColor = COLOR_SELECTABLE_FILL;
        fillAlpha = 0.4;
        strokeColor = COLOR_SELECTABLE_STROKE;
        strokeWidth = 1.5;
        strokeAlpha = 0.7;
      } else {
        // spawn-mode locked (e.g. limbo restricts selection)
        fillColor = COLOR_LOCKED_FILL;
        fillAlpha = 0;
        strokeColor = COLOR_LOCKED_STROKE;
        strokeWidth = 1.5;
        strokeAlpha = 0.45;
      }

      hex.clear();
      const verts = hexVertices(HEX_SIZE);
      if (fillAlpha > 0) {
        hex.poly(verts);
        hex.fill({ color: fillColor, alpha: fillAlpha });
      }
      hex.poly(verts);
      hex.stroke({ color: strokeColor, width: strokeWidth, alpha: strokeAlpha });

      hex.eventMode = selectable ? 'static' : 'none';
      hex.cursor = selectable ? 'pointer' : 'default';

      label.style.fill = (selectable || highlighted || informational) ? COLOR_LABEL_ACTIVE : COLOR_LABEL_LOCKED;
      label.alpha = highlighted || selectable ? 1 : informational ? 0.85 : 0.6;

      resumeLabel.visible = isLimbo;
    }
    this.repaintEdges();
  }

  private repaintEdges(): void {
    const removed = this.edgeLayer.removeChildren();
    for (const c of removed) c.destroy();
    const edges = new Graphics();
    const seen = new Set<string>();
    const isWarp = this.mode === 'warp';
    for (const entry of this.entries) {
      for (const nKey of entry.sector.neighbours) {
        const a = entry.sector.key;
        const b = nKey;
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const target = this.entries.find((e) => e.sector.key === nKey);
        if (!target) continue;
        const adjacentToCurrent = a === this.currentSectorKey || b === this.currentSectorKey;

        let strokeColor: number;
        let strokeAlpha: number;
        if (isWarp) {
          // Warp-mode: every edge visible, just emphasised on routes the
          // player can actually take from where they are now.
          strokeColor = COLOR_SELECTABLE_STROKE;
          strokeAlpha = adjacentToCurrent ? 0.9 : 0.4;
        } else {
          // Spawn-mode: edge "active" only if both endpoints are reachable.
          const aActive = this.isSelectable(entry.sector) || a === this.currentSectorKey;
          const bActive = this.isSelectable(target.sector) || b === this.currentSectorKey;
          const active = aActive && bActive;
          strokeColor = active ? COLOR_SELECTABLE_STROKE : COLOR_LOCKED_STROKE;
          strokeAlpha = active ? 0.9 : 0.35;
        }
        edges.moveTo(entry.x, entry.y).lineTo(target.x, target.y);
        edges.stroke({ color: strokeColor, width: 1.5, alpha: strokeAlpha });
      }
    }
    this.edgeLayer.addChild(edges);
  }

  private readonly tickPulse = (): void => {
    this.resumePulsePhase += 0.04;
    if (this.resumePulsePhase > Math.PI * 2) this.resumePulsePhase -= Math.PI * 2;
    const alpha = 0.55 + 0.45 * Math.abs(Math.sin(this.resumePulsePhase));
    for (const entry of this.entries) {
      if (entry.resumeLabel.visible) entry.resumeLabel.alpha = alpha;
    }
  };
}
