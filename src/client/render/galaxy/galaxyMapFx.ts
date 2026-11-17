import { Graphics, type Container, type Sprite } from 'pixi.js';
import type { GalaxySector } from '@core/galaxy/galaxy';
import type { SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import { factionBorderColor, isNewFlip, FLIP_RING_MS, THREAT_BRACKET_COLOR } from './galaxyTerritories';
import { drawFlipRing } from './galaxyHexDraw';
import {
  GalaxyMotion,
  flareAt,
  flipRingAfterWipe,
  hotPulseAlpha,
  nebulaDrift,
} from './galaxyMapMotion';

/** What the fx needs of a `GalaxyMapLayer` hex entry. */
export interface FxHex {
  readonly sector: GalaxySector;
  readonly x: number;
  readonly y: number;
  readonly territoryIndex: number;
  readonly ownerId: string;
}

const FLARE_COLOR = 0xff7043;
/** Reused stroke style for the per-frame flare (Pixi copies it on stroke). */
const FLARE_STROKE = { color: FLARE_COLOR, width: 3, alpha: 1 };

/**
 * The galaxy map's motion layer (Pixi side of `galaxyMapMotion.ts`), driven by
 * the existing `GalaxyMapLayer` ticker: flip rings (moved here from the layer),
 * hot-front glows, new-fighting flares, and the nebula drift. Per territory it
 * adds three Graphics to the territory container: the flip ring, the hot glow
 * (drawn at feed cadence, pulsed by alpha) and the flare (redrawn per frame
 * only while a flare runs). Hex fills that are mid-tween are repainted through
 * the layer's `paint(i)` callback; idle hexes do no work.
 */
export class GalaxyMapFx {
  readonly motion: GalaxyMotion;
  private readonly rings: Graphics[] = [];
  private readonly hots: Graphics[] = [];
  private readonly flares: Graphics[] = [];
  /** Last `control.flippedAtMs` per sector (undefined before the first poll). */
  private readonly lastFlippedAt = new Map<string, number | null>();
  /** UI clock (ms) at which the client saw each sector's latest flip. */
  private readonly flipSeenAt = new Map<string, number>();
  private active = false;
  private flaring = false;
  private hotAny = false;
  private readonly flare = { radius: 0, alpha: 0 };
  private readonly drift = { dx: 0, dy: 0, scale: 1, alpha: 1 };
  private readonly nebulaX: number;
  private readonly nebulaY: number;
  private readonly nebulaScale: number;

  constructor(reducedMotion: boolean, private readonly nebula: Sprite) {
    this.motion = new GalaxyMotion(reducedMotion);
    this.nebulaX = nebula.x;
    this.nebulaY = nebula.y;
    this.nebulaScale = nebula.scale.x;
  }

  /** Forget the per-territory Graphics (their containers were destroyed). */
  resetTerritories(): void {
    this.rings.length = 0;
    this.hots.length = 0;
    this.flares.length = 0;
  }

  /** Add the hot glow, flip ring and flare Graphics to a territory container. */
  addTerritory(container: Container): void {
    const hot = new Graphics();
    const ring = new Graphics();
    const flare = new Graphics();
    ring.visible = false;
    container.addChild(hot, ring, flare);
    this.hots.push(hot);
    this.rings.push(ring);
    this.flares.push(flare);
  }

  /** A feed poll: start tweens, wipes and flares; note new flips. */
  onFeed(byKey: ReadonlyMap<string, SectorLiveState>, sectors: readonly GalaxySector[], nowMs: number): void {
    this.motion.onFeed(byKey, nowMs);
    for (const s of sectors) {
      const next = byKey.get(s.key)?.control?.flippedAtMs ?? null;
      if (isNewFlip(this.lastFlippedAt.get(s.key), next)) this.flipSeenAt.set(s.key, nowMs);
      this.lastFlippedAt.set(s.key, next);
    }
    this.active = this.motion.anyActive();
    this.hotAny = this.motion.anyHot();
  }

  /** Feed cadence: redraw flip rings and hot glows (the ticker only fades them). */
  redraw(entries: readonly FxHex[], containers: readonly Container[], hexSize: number, hexFlat: readonly number[]): void {
    this.redrawRings(entries, containers, hexSize);
    for (const g of this.hots) g.clear();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const container = containers[e.territoryIndex];
      if (!container) continue;
      const ox = e.x - container.x;
      const oy = e.y - container.y;
      const hot = this.hots[e.territoryIndex];
      if (hot && this.motion.isHot(i)) {
        const pts: number[] = [];
        for (let k = 0; k < hexFlat.length; k += 2) pts.push(ox + hexFlat[k]! * 1.02, oy + hexFlat[k + 1]! * 1.02);
        hot.poly(pts).stroke({ color: THREAT_BRACKET_COLOR, width: 6, alpha: 1, join: 'round' });
      }
    }
  }

  /**
   * Per frame (allocation-free). `paint(i)` repaints entry i's hex fill;
   * `pulse` is the layer's current-sector pulse (the flip ring keeps it).
   */
  tick(
    entries: readonly FxHex[], containers: readonly Container[], nowMs: number, pulse: number,
    hexSize: number, paint: (i: number) => void, fullPage: boolean,
  ): void {
    if (this.hotAny) {
      const a = hotPulseAlpha(nowMs, this.motion.reducedMotion);
      for (let t = 0; t < this.hots.length; t++) this.hots[t]!.alpha = a;
    }
    if (this.flipSeenAt.size > 0) this.fadeFlipRings(entries, nowMs, pulse, containers, hexSize);
    if (fullPage && this.nebula.visible) this.driftNebula(nowMs);
    if (!this.active && !this.flaring) return;
    const wasFlaring = this.flaring;
    this.flaring = false;
    for (let i = 0; i < entries.length; i++) {
      if (this.motion.isAnimating(i, nowMs)) paint(i);
      else if (this.motion.settle(i, nowMs)) paint(i);
      if (this.motion.flareAge(i, nowMs) >= 0) this.flaring = true;
    }
    if (this.flaring || wasFlaring) this.drawFlares(entries, containers, nowMs, hexSize);
    this.active = this.motion.anyActive();
  }

  private fadeFlipRings(entries: readonly FxHex[], nowMs: number, pulse: number, containers: readonly Container[], hexSize: number): void {
    let expired = false;
    for (let i = 0; i < this.rings.length; i++) this.rings[i]!.alpha = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const seen = this.flipSeenAt.get(e.sector.key);
      if (seen === undefined) continue;
      const age = nowMs - seen;
      if (age >= FLIP_RING_MS) {
        this.flipSeenAt.delete(e.sector.key);
        expired = true;
        continue;
      }
      const ring = this.rings[e.territoryIndex];
      if (ring) ring.alpha = Math.max(ring.alpha, flipRingAfterWipe(age) * pulse);
    }
    if (expired) this.redrawRings(entries, containers, hexSize);
  }

  private redrawRings(entries: readonly FxHex[], containers: readonly Container[], hexSize: number): void {
    for (const g of this.rings) {
      g.clear();
      g.visible = false;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const ring = this.rings[e.territoryIndex];
      const container = containers[e.territoryIndex];
      if (!ring || !container || !this.flipSeenAt.has(e.sector.key)) continue;
      drawFlipRing(ring, e.x - container.x, e.y - container.y, hexSize * 0.78, factionBorderColor(e.ownerId));
      ring.visible = true;
    }
  }

  private drawFlares(entries: readonly FxHex[], containers: readonly Container[], nowMs: number, hexSize: number): void {
    for (let t = 0; t < this.flares.length; t++) this.flares[t]!.clear();
    for (let i = 0; i < entries.length; i++) {
      const age = this.motion.flareAge(i, nowMs);
      if (age < 0) continue;
      const e = entries[i]!;
      const g = this.flares[e.territoryIndex];
      const container = containers[e.territoryIndex];
      if (!g || !container) continue;
      flareAt(age, this.flare);
      FLARE_STROKE.alpha = this.flare.alpha;
      FLARE_STROKE.width = 2 + 4 * this.flare.alpha;
      g.circle(e.x - container.x, e.y - container.y, hexSize * this.flare.radius).stroke(FLARE_STROKE);
    }
  }

  private driftNebula(nowMs: number): void {
    nebulaDrift(nowMs, this.motion.reducedMotion, this.drift);
    const n = this.nebula;
    const s = this.nebulaScale * this.drift.scale;
    n.scale.set(s);
    // Scale about the cloud's centre, not its top-left corner.
    n.x = this.nebulaX + this.drift.dx - (n.texture.width * (s - this.nebulaScale)) / 2;
    n.y = this.nebulaY + this.drift.dy - (n.texture.height * (s - this.nebulaScale)) / 2;
    n.alpha = this.drift.alpha;
  }
}
