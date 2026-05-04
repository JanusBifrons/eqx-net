import { Container, Graphics } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { useUIStore } from '../state/store';

const ASTEROID_COLOR = 0x886644;
const DRONE_COLOR = 0xff3366;
const REMOTE_SHIP_COLOR = 0x00aaff;
// Halo radii are specified in screen pixels and converted to world units each
// frame using the viewport's current zoom — keeps the halo visually consistent
// regardless of zoom level.
const INNER_RADIUS_PX = 90;
const OUTER_RADIUS_PX = 220;
const ARROW_SCALE_NEAR = 1.4;
const ARROW_SCALE_FAR = 0.6;
// World-unit distance band used to lerp arrow radius and scale.
const DIST_MIN = 200;
const DIST_MAX = 5000;
// Padded so arrows don't flicker when a POI sits exactly on a viewport edge.
const VISIBILITY_PADDING_WORLD = 16;
// Hard cap so a swarm of 200 drones doesn't render 200 arrows. Closest first.
const MAX_ARROWS = 64;

export interface HaloProjectionParams {
  innerRadius: number;
  outerRadius: number;
  distMin: number;
  distMax: number;
  scaleNear: number;
  scaleFar: number;
  visiblePadding: number;
  visibleLeft: number;
  visibleRight: number;
  visibleTop: number;
  visibleBottom: number;
}

export interface HaloProjection {
  hidden: boolean;
  /** Pixi-space x (= world x). */
  x: number;
  /** Pixi-space y (= -world y). */
  y: number;
  /** Pixi-space rotation (= -world theta). */
  rotation: number;
  scale: number;
}

export function clamp(t: number, lo: number, hi: number): number {
  return t < lo ? lo : t > hi ? hi : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Pure helper. Given the player position, a POI position (both in world
 * coordinates) and visibility bounds expressed in Pixi space (y-flipped), it
 * returns where the arrow should sit on the halo and how big it should be —
 * or `hidden: true` if the POI is on-screen.
 *
 * Visibility test uses Pixi space because that's what `viewport.getVisibleBounds()`
 * returns. The renderer mirrors world Y to Pixi `-y` consistently elsewhere.
 */
export function projectArrow(
  local: { x: number; y: number },
  poi: { x: number; y: number },
  params: HaloProjectionParams,
): HaloProjection {
  const poiPixiY = -poi.y;
  const inside =
    poi.x >= params.visibleLeft - params.visiblePadding &&
    poi.x <= params.visibleRight + params.visiblePadding &&
    poiPixiY >= params.visibleTop - params.visiblePadding &&
    poiPixiY <= params.visibleBottom + params.visiblePadding;

  if (inside) return { hidden: true, x: 0, y: 0, rotation: 0, scale: 0 };

  const dx = poi.x - local.x;
  const dy = poi.y - local.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { hidden: true, x: 0, y: 0, rotation: 0, scale: 0 };

  const theta = Math.atan2(dy, dx);
  const t = clamp((dist - params.distMin) / (params.distMax - params.distMin), 0, 1);
  const r = lerp(params.innerRadius, params.outerRadius, t);
  const scale = lerp(params.scaleNear, params.scaleFar, t);

  return {
    hidden: false,
    x: local.x + Math.cos(theta) * r,
    y: -(local.y + Math.sin(theta) * r),
    rotation: -theta,
    scale,
  };
}

function buildArrowGfx(color: number): Graphics {
  const g = new Graphics();
  // Triangle nose along local +x. After `rotation = -theta` it points along
  // the world bearing to the POI.
  g.poly([
    { x: 14, y: 0 },
    { x: -8, y: -8 },
    { x: -8, y: 8 },
  ]);
  g.fill({ color, alpha: 0.95 });
  g.poly([
    { x: 14, y: 0 },
    { x: -8, y: -8 },
    { x: -8, y: 8 },
  ]);
  g.stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
  return g;
}

interface Candidate {
  key: string;
  x: number;
  y: number;
  color: number;
  dist: number;
}

export class HaloRadar {
  private readonly container = new Container();
  private viewport: Viewport | null = null;
  private readonly arrows = new Map<string, Graphics>();

  init(viewport: Viewport): void {
    this.viewport = viewport;
    viewport.addChild(this.container);
  }

  update(mirror: RenderMirror): void {
    const viewport = this.viewport;
    if (!viewport) return;

    // During SPOOLING / IN_TRANSIT / ARRIVED the player is between rooms; the
    // mirror may still hold the old sector's swarm/ships while the local ship
    // moves to the new spawn. Drawing arrows for cross-sector ghosts is just
    // visual noise — and the warp overlay covers the screen anyway. Destroy
    // any pooled arrows so a fresh sector starts clean.
    const transitState = useUIStore.getState().transitState;
    if (transitState !== 'DOCKED') {
      for (const arrow of this.arrows.values()) {
        this.container.removeChild(arrow);
        arrow.destroy();
      }
      this.arrows.clear();
      return;
    }

    const localId = mirror.localPlayerId;
    const local = localId ? mirror.ships.get(localId) : null;
    if (!local) {
      for (const g of this.arrows.values()) g.visible = false;
      return;
    }

    const bounds = viewport.getVisibleBounds();
    const scaleX = viewport.scale.x || 1;

    const params: HaloProjectionParams = {
      innerRadius: INNER_RADIUS_PX / scaleX,
      outerRadius: OUTER_RADIUS_PX / scaleX,
      distMin: DIST_MIN,
      distMax: DIST_MAX,
      scaleNear: ARROW_SCALE_NEAR,
      scaleFar: ARROW_SCALE_FAR,
      visiblePadding: VISIBILITY_PADDING_WORLD,
      visibleLeft: bounds.left,
      visibleRight: bounds.right,
      visibleTop: bounds.top,
      visibleBottom: bounds.bottom,
    };

    const candidates: Candidate[] = [];
    const presentKeys = new Set<string>();

    if (mirror.swarm) {
      for (const [id, e] of mirror.swarm) {
        const key = `swarm:${id}`;
        presentKeys.add(key);
        const dist = Math.hypot(e.x - local.x, e.y - local.y);
        candidates.push({
          key,
          x: e.x,
          y: e.y,
          color: e.kind === 1 ? DRONE_COLOR : ASTEROID_COLOR,
          dist,
        });
      }
    }
    for (const [id, s] of mirror.ships) {
      if (id === localId) continue;
      const key = `ship:${id}`;
      presentKeys.add(key);
      const dist = Math.hypot(s.x - local.x, s.y - local.y);
      candidates.push({ key, x: s.x, y: s.y, color: REMOTE_SHIP_COLOR, dist });
    }

    if (candidates.length > MAX_ARROWS) {
      candidates.sort((a, b) => a.dist - b.dist);
      candidates.length = MAX_ARROWS;
    }

    const renderedKeys = new Set<string>();
    for (const c of candidates) {
      const proj = projectArrow({ x: local.x, y: local.y }, { x: c.x, y: c.y }, params);
      let arrow = this.arrows.get(c.key);
      if (proj.hidden) {
        if (arrow) arrow.visible = false;
        continue;
      }
      if (!arrow) {
        arrow = buildArrowGfx(c.color);
        this.container.addChild(arrow);
        this.arrows.set(c.key, arrow);
      }
      renderedKeys.add(c.key);
      arrow.visible = true;
      arrow.x = proj.x;
      arrow.y = proj.y;
      arrow.rotation = proj.rotation;
      arrow.scale.set(proj.scale);
    }

    for (const [key, arrow] of this.arrows) {
      if (!renderedKeys.has(key)) arrow.visible = false;
      if (!presentKeys.has(key)) {
        this.container.removeChild(arrow);
        arrow.destroy();
        this.arrows.delete(key);
      }
    }
  }

  /** Test-only — number of currently-visible arrows in the scene graph. */
  getDebugVisibleArrowCount(): number {
    let n = 0;
    for (const a of this.arrows.values()) if (a.visible) n++;
    return n;
  }

  destroy(): void {
    for (const g of this.arrows.values()) g.destroy();
    this.arrows.clear();
    this.container.destroy({ children: true });
    this.viewport = null;
  }
}
