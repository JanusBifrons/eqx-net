/**
 * Pure entity pick — "what did the player tap?" (structures follow-up Item B1).
 *
 * Scans the render mirror for the nearest selectable entity within a
 * radius/tap-slop of a GAME-space point and returns a stable id + kind, or
 * `null` for empty space. Pure: no Pixi, no DOM, no module state — same inputs
 * ⇒ same output, so it is unit-testable without a renderer.
 *
 * Selectable kinds:
 *   - SHIPS (`mirror.ships`) — EXCLUDING the ship I'm flying
 *     (`isShipIAmFlying`: the entry at key `localPlayerId`). Parked hulls share
 *     the map since RTS Part A S3 under their shipInstanceId, so a displaced
 *     player's old hull never collides with that key.
 *   - DRONES (`mirror.swarm`, `kind === 1`), STRUCTURES (`kind === 2`) and
 *     ASTEROIDS (`kind === 0`, WS-9/R2.23 — "every entity should be selectable
 *     except weapons fire").
 *   - PARKED HULLS (`mirror.ships` entries `isParkedHull`, kind 'lingering';
 *     WS-9/R2.23 — surface the owner).
 *   - CARGO PODS (`kind === 3` records `isLootPod`, kind 'pod'; cargo pods
 *     slice 15 — tap to select, then Open). Other scrap stays unselectable.
 *
 * Explicitly NOT selectable: weapons fire (projectiles / missiles / beams live
 * in their own mirror maps, never scanned here).
 *
 * Returned ids mirror the `HealthBarManager` lookup convention so a downstream
 * consumer (the selection bracket) can resolve the entity's live pose every
 * frame the same way:
 *   - ship  → `playerId` (key in `mirror.ships`)
 *   - drone / structure / asteroid → `swarm-${entityId}`
 *   - lingering → `shipInstanceId` (its key in `mirror.ships`)
 *
 * Radius model: swarm entries carry a `radius`; ships derive theirs from
 * the ship-kind catalogue collision radius. The hit test is "distance to centre
 * < entity radius + TAP_SLOP" so a tap just outside a small drone still lands.
 * Among overlapping candidates the NEAREST centre wins.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getStructureKind, isStructureKindId } from '../../shared-types/structureKinds.js';
import { getShipKind } from '@shared-types/shipKinds';
import { isParkedHull, isShipIAmFlying } from './shipOwnership.js';
import { isLootPod } from '@shared-types/swarmWireFormat';
import { craneBayFor } from '../../core/articulation/craneRig.js';

/** Selectable entity classes. `drone`/`asteroid`/`lingering` read from
 *  the mirror directly (no server stats channel); `ship`/`structure` use
 *  `entity_stats` for hp/shield (structures also read their slice from the
 *  mirror — WS-9/R2.8). */
export type PickedEntityKind = 'ship' | 'drone' | 'structure' | 'asteroid' | 'lingering' | 'pod';

export interface PickedEntity {
  /** Mirror-resolvable id (see module docstring for the per-kind form). */
  id: string;
  kind: PickedEntityKind;
}

/** Extra grab radius (world units) added to every entity's own radius so a tap
 *  near a small target still selects it. Generous on purpose — selection is a
 *  deliberate gesture and a near-miss is more annoying than an over-grab. */
export const TAP_SLOP = 24;

/** A finger's grab slop in SCREEN pixels (the ghost-drag finger slop's size):
 *  a touch pick converts it to world units at the camera zoom, so a zoomed-out
 *  Command view still gives a fingertip-sized reach. */
export const FINGER_SLOP_PX = 24;

/** World-unit pick slop for a touch at camera scale `scale` (screen px per
 *  world unit): the finger's screen slop, never less than {@link TAP_SLOP}. */
export function fingerSlopWorld(scale: number): number {
  return scale > 0 ? Math.max(TAP_SLOP, FINGER_SLOP_PX / scale) : TAP_SLOP;
}

/** Fallback collision radius when a ship kind can't be resolved. */
const SHIP_FALLBACK_RADIUS = 20;

export function pickEntityAt(
  worldX: number,
  worldY: number,
  mirror: RenderMirror,
  /** Extra grab reach in world units (a touch passes {@link fingerSlopWorld}). */
  slop: number = TAP_SLOP,
): PickedEntity | null {
  let bestId: string | null = null;
  let bestKind: PickedEntityKind = 'ship';
  // Compare by centre distance among entities whose hit-disc contains the tap.
  let bestDistSq = Infinity;

  // ── Every ship (pilots' by playerId, parked hulls by shipInstanceId; #17:
  // ACTIVE + LINGERING). Exclude the ship I'm flying. ──
  for (const [id, ship] of mirror.ships) {
    if (isShipIAmFlying(mirror, id)) continue; // own ship — never selectable
    const radius = shipRadius(ship.kind);
    const dx = ship.x - worldX;
    const dy = ship.y - worldY;
    const distSq = dx * dx + dy * dy;
    const reach = radius + slop;
    if (distSq <= reach * reach && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = id;
      // A parked hull (shipInstanceId key, same list since RTS Part A S3)
      // keeps its own pick kind (WS-9/R2.23: surfaces whose hull it is).
      bestKind = isParkedHull(mirror, id, ship) ? 'lingering' : 'ship';
    }
  }

  // ── Swarm: asteroids (kind 0), drones (kind 1), structures (kind 2). ──
  // WS-9/R2.23 — asteroids are now selectable (size/resources readout).
  if (mirror.swarm) {
    for (const [entityId, sw] of mirror.swarm) {
      const pod = isLootPod(sw);
      if (sw.kind !== 0 && sw.kind !== 1 && sw.kind !== 2 && !pod) continue; // unknown kind / plain scrap
      const dx = sw.x - worldX;
      const dy = sw.y - worldY;
      const distSq = dx * dx + dy * dy;
      let hit: boolean;
      if (sw.kind === 2 && sw.shipKind && isStructureKindId(sw.shipKind)) {
        // Phase V — a structure is its (quarter-turn) footprint box, not its
        // bounding circle: a tap in the empty corner beside a long Solar must
        // not select it. Inline (no allocation — runs on pointer-move hover).
        const fp = getStructureKind(sw.shipKind).footprint;
        const quarter = Math.round((sw.angle * 2) / Math.PI) % 2 !== 0;
        const hw = (quarter ? fp.h : fp.w) / 2 + slop;
        const hh = (quarter ? fp.w : fp.h) / 2 + slop;
        hit = Math.abs(dx) <= hw && Math.abs(dy) <= hh;
      } else {
        const reach = sw.radius + slop;
        hit = distSq <= reach * reach;
      }
      if (hit && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = `swarm-${entityId}`;
        bestKind = pod ? 'pod' : sw.kind === 0 ? 'asteroid' : sw.kind === 1 ? 'drone' : 'structure';
      }
    }
  }

  if (bestId === null) return null;
  return { id: bestId, kind: bestKind };
}

/**
 * Is GAME-space (x, y) on a structure's crane bay pad (`craneBayFor`: the
 * Capital's built-in bay, a freight dock's)? The whole pad, edge to edge
 * (`inCraneBay`'s parking inset is the serve rule, not the tap rule). A pad
 * is open space a ship parks on, so the Fly tap there is a helm course,
 * whatever else the pick's slop reaches (a hull parked on it, the host's
 * own tap slop over the pad's inner strip). Alloc-free.
 */
export function onCraneBayPad(x: number, y: number, mirror: RenderMirror): boolean {
  if (!mirror.swarm) return false;
  for (const sw of mirror.swarm.values()) {
    if (sw.kind !== 2 || !sw.shipKind) continue;
    const bay = craneBayFor(sw.shipKind);
    if (bay === null) continue;
    // World → host frame (the structure's body angle, radians).
    const dx = x - sw.x, dy = y - sw.y;
    const cs = Math.cos(sw.angle), sn = Math.sin(sw.angle);
    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
    if (Math.abs(lx - bay.cx) <= bay.padHalfW && Math.abs(ly - bay.cy) <= bay.padHalfH) return true;
  }
  return false;
}

/** Collision/sprite radius for a ship kind, with a safe fallback. */
function shipRadius(kind: string | undefined): number {
  const k = getShipKind(kind);
  return k?.radius ?? SHIP_FALLBACK_RADIUS;
}
