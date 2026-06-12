/**
 * Pure entity pick — "what did the player tap?" (structures follow-up Item B1).
 *
 * Scans the render mirror for the nearest selectable entity within a
 * radius/tap-slop of a GAME-space point and returns a stable id + kind, or
 * `null` for empty space. Pure: no Pixi, no DOM, no module state — same inputs
 * ⇒ same output, so it is unit-testable without a renderer.
 *
 * Selectable kinds:
 *   - player SHIPS (`mirror.ships`, playerId-keyed) — EXCLUDING the local
 *     player's own ACTIVE ship. The own ship is the `mirror.ships` entry at key
 *     `localPlayerId`; lingering hulls of a displaced player live in a SEPARATE
 *     map (`mirror.lingeringShips`) and are not scanned here, so excluding the
 *     `localPlayerId` key excludes exactly the own ship and nothing else. (The
 *     handoff frames this as "exclude via `localShipInstanceId`, not
 *     `localPlayerId`" because `mirror.ships` carries no instanceId; the
 *     displaced-player case it warns about is structurally impossible to
 *     mis-handle here precisely because lingering hulls aren't in `mirror.ships`.)
 *   - DRONES (`mirror.swarm`, `kind === 1`), STRUCTURES (`kind === 2`) and
 *     ASTEROIDS (`kind === 0`, WS-9/R2.23 — "every entity should be selectable
 *     except weapons fire").
 *   - WRECKS (`mirror.wrecks`) and LINGERING HULLS (`mirror.lingeringShips`,
 *     WS-9/R2.23 — surface the owner).
 *
 * Explicitly NOT selectable: weapons fire (projectiles / missiles / beams live
 * in their own mirror maps, never scanned here).
 *
 * Returned ids mirror the `HealthBarManager` lookup convention so a downstream
 * consumer (the selection bracket) can resolve the entity's live pose every
 * frame the same way:
 *   - ship  → `playerId` (key in `mirror.ships`)
 *   - drone / structure / asteroid → `swarm-${entityId}`
 *   - wreck → `shipInstanceId` (key in `mirror.wrecks`)
 *   - lingering → `shipInstanceId` (key in `mirror.lingeringShips`)
 *
 * Radius model: swarm entries carry a `radius`; ships/wrecks derive theirs from
 * the ship-kind catalogue collision radius. The hit test is "distance to centre
 * < entity radius + TAP_SLOP" so a tap just outside a small drone still lands.
 * Among overlapping candidates the NEAREST centre wins.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';

/** Selectable entity classes. `drone`/`wreck`/`asteroid`/`lingering` read from
 *  the mirror directly (no server stats channel); `ship`/`structure` use
 *  `entity_stats` for hp/shield (structures also read their slice from the
 *  mirror — WS-9/R2.8). */
export type PickedEntityKind = 'ship' | 'drone' | 'structure' | 'wreck' | 'asteroid' | 'lingering';

export interface PickedEntity {
  /** Mirror-resolvable id (see module docstring for the per-kind form). */
  id: string;
  kind: PickedEntityKind;
}

/** Extra grab radius (world units) added to every entity's own radius so a tap
 *  near a small target still selects it. Generous on purpose — selection is a
 *  deliberate gesture and a near-miss is more annoying than an over-grab. */
export const TAP_SLOP = 24;

/** Fallback collision radius when a ship kind can't be resolved. */
const SHIP_FALLBACK_RADIUS = 20;

export function pickEntityAt(
  worldX: number,
  worldY: number,
  mirror: RenderMirror,
): PickedEntity | null {
  let bestId: string | null = null;
  let bestKind: PickedEntityKind = 'ship';
  // Compare by centre distance among entities whose hit-disc contains the tap.
  let bestDistSq = Infinity;

  const localId = mirror.localPlayerId;

  // ── Player ships (playerId-keyed). Exclude the own active ship. ──
  for (const [id, ship] of mirror.ships) {
    if (id === localId) continue; // own ship — never selectable
    const radius = shipRadius(ship.kind);
    const dx = ship.x - worldX;
    const dy = ship.y - worldY;
    const distSq = dx * dx + dy * dy;
    const reach = radius + TAP_SLOP;
    if (distSq <= reach * reach && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = id;
      bestKind = 'ship';
    }
  }

  // ── Swarm: asteroids (kind 0), drones (kind 1), structures (kind 2). ──
  // WS-9/R2.23 — asteroids are now selectable (size/resources readout).
  if (mirror.swarm) {
    for (const [entityId, sw] of mirror.swarm) {
      if (sw.kind !== 0 && sw.kind !== 1 && sw.kind !== 2) continue; // unknown kind
      const dx = sw.x - worldX;
      const dy = sw.y - worldY;
      const distSq = dx * dx + dy * dy;
      const reach = sw.radius + TAP_SLOP;
      if (distSq <= reach * reach && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = `swarm-${entityId}`;
        bestKind = sw.kind === 0 ? 'asteroid' : sw.kind === 1 ? 'drone' : 'structure';
      }
    }
  }

  // ── Wrecks (shipInstanceId-keyed). ──
  if (mirror.wrecks) {
    for (const [shipInstanceId, wreck] of mirror.wrecks) {
      const radius = shipRadius(wreck.kind);
      const dx = wreck.x - worldX;
      const dy = wreck.y - worldY;
      const distSq = dx * dx + dy * dy;
      const reach = radius + TAP_SLOP;
      if (distSq <= reach * reach && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = shipInstanceId;
        bestKind = 'wreck';
      }
    }
  }

  // ── Lingering hulls (shipInstanceId-keyed; displaced/disconnected players).
  // WS-9/R2.23 — selectable to surface whose hull it is. ──
  if (mirror.lingeringShips) {
    for (const [shipInstanceId, l] of mirror.lingeringShips) {
      const radius = shipRadius(l.kind);
      const dx = l.x - worldX;
      const dy = l.y - worldY;
      const distSq = dx * dx + dy * dy;
      const reach = radius + TAP_SLOP;
      if (distSq <= reach * reach && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = shipInstanceId;
        bestKind = 'lingering';
      }
    }
  }

  if (bestId === null) return null;
  return { id: bestId, kind: bestKind };
}

/** Collision/sprite radius for a ship/wreck kind, with a safe fallback. */
function shipRadius(kind: string | undefined): number {
  const k = getShipKind(kind);
  return k?.radius ?? SHIP_FALLBACK_RADIUS;
}
