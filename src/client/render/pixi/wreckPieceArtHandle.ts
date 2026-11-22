/**
 * Which baked art a wreck piece wears, by what the wreck was cut from
 * (`wreckSourceKindOf`): a ship's piece the bake its live hull wore
 * (`wreckArtHandleFor`), a structure's piece the structure's own bake
 * (`structHandleFor`), a rock's none (it draws the field rock shader).
 * No new bake job and no new texture: a structure's one lit frame is handed
 * to `WreckPieceSprite` in `ShipArt`'s shape (`structArtAsShipArt`).
 *
 * Per frame: map lookups and compares only (invariant #14); the adapter
 * allocates once per structure bake (memoised on the `StructArt`).
 */
import { destructionProfileOf } from '../../../shared-types/shipScale/destructionProfile.js';
import type { WreckDescriptor } from '../../../shared-types/messages/wreckDescriptor.js';
import type { WreckSource } from '../../../core/destruction/wreckSource.js';
import type { ArtHandle, ShipArt, StructArt } from '../art/ArtService.js';
import { structHandleFor, wreckArtHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import { wreckSourceKindOf } from '../../net/wreckRootSource.js';
import { structureTurrets, turretBakeJobs } from '../art/turretLayout.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';

/** Per parent kind: do its wreck pieces draw the dead bake (`fx.deadArt`)?
 *  Filled once per kind (the profile lookup allocates its argument). */
const wreckDeadArt = new Map<string, boolean>();
export function wreckDeadArtFor(kindId: string): boolean {
  let v = wreckDeadArt.get(kindId);
  if (v === undefined) {
    v = destructionProfileOf({ type: 'ship', kindId }).fx.deadArt;
    wreckDeadArt.set(kindId, v);
  }
  return v;
}

/**
 * A wreck piece's parent art handle (null: no art, the plain piece).
 *  - ship: the live hull's bake (owner: the descriptor's, else `faction`);
 *  - structure: the structure kind's bake (`source.structure.k`, the root's,
 *    so a re-split child finds it too) at the quarter turn the live
 *    structure wore (`rot`: the piece's `-angle` on its first ask, still its
 *    death pose; held after, however it spins), and the descriptor's owner
 *    if it carries one (the live structure's livery), else no owner:
 *    `structHandleFor`'s catalogue-colour bake. A Baked (unlit) structure's
 *    turn joins its bake key (the sun only; the art is not turned, so the
 *    UVs are the same): turn 0 for a structure placed at a quarter turn was
 *    a fresh bake its pieces waited on as flat grey polygons, while its own
 *    turn is the bake already cached. GPU-lit art ignores the turn;
 *  - rock: none.
 */
export function wreckPieceArtHandle(
  actx: ShipArtCtx, key: string, desc: WreckDescriptor, parent: string, faction: string | undefined, source: WreckSource | undefined,
  rot = 0,
): ArtHandle | null {
  if (actx.art === null) return null;
  switch (wreckSourceKindOf(desc.parentKind)) {
    case 'ship':
      return wreckArtHandleFor(actx, key, parent, desc.owner ?? faction, wreckDeadArtFor(parent));
    case 'structure': {
      const k = source?.structure?.k;
      if (k === undefined) return null;
      // The turn this piece first asked for, held while it spins (no re-bake per quarter turn).
      const h = actx.handles.get(key);
      return structHandleFor(actx, key, k, h !== undefined && h.job.type === 'struct' ? h.job.rot ?? 0 : rot, desc.owner);
    }
    default:
      return null;
  }
}

const asShipArt = new WeakMap<StructArt, ShipArt>();

/**
 * A structure's bake in `ShipArt`'s shape, for `WreckPieceSprite`: one
 * untiled frame (`tex`, the lit map frame on GPU-lit art), the same size,
 * density and lit facts. The bake is centred on the structure (`gridFor` is
 * symmetric) in its Pixi-down local frame, as `MachinedFlatSprite` draws it,
 * so `wreckTexLayout` / `wreckPieceMeshes` map a piece's outline frame into
 * it exactly as they map a ship's. Memoised: the same object per bake, so
 * the updater's "already wearing this art" check is an identity compare.
 */
export function structArtAsShipArt(s: StructArt): ShipArt {
  let a = asShipArt.get(s);
  if (a === undefined) {
    a = { frames: [s.tex], w: s.w, h: s.h, tiles: 1, tileH: s.h, density: s.density, nozzles: [], navLights: s.navLights, ...(s.lit ? { lit: s.lit } : {}) };
    asShipArt.set(s, a);
  }
  return a;
}

/** The ready art a piece wears: a ship's bake, or a structure's adapted;
 *  null while the handle is missing or not ready (the plain piece). */
export function wreckPieceArtOf(h: ArtHandle | null): ShipArt | null {
  if (h === null || h.state !== 'ready') return null;
  if (h.ship !== null) return h.ship;
  return h.struct !== null ? structArtAsShipArt(h.struct) : null;
}

/**
 * A structure piece's gun bakes, per `structureTurrets(kindId)` place: the
 * live turret's own (`turretBakeJobs` with the paint `machinedGunFor` uses:
 * the structure bake's accent, else the kind colour), so the handle is the
 * one the live gun wore; a gun's entry is its ready art, else null (the
 * piece draws the bar, as the live mount did before its bake). Null with
 * Machined turrets off or no structure bake. Build time only (allocates).
 */
export function structureWreckGunArts(actx: ShipArtCtx, h: ArtHandle | null, kindId: string): Array<ShipArt | null> | null {
  if (actx.art === null || actx.turrets !== true || h === null || h.job.type !== 'struct') return null;
  const places = structureTurrets(kindId);
  if (places.length === 0) return null;
  const paint = h.job.accent ?? getStructureKind(kindId).color;
  const out: Array<ShipArt | null> = [];
  for (const p of places) {
    const g = actx.art.acquire(turretBakeJobs(p, paint, true).gun);
    out.push(g.state === 'ready' ? g.ship : null);
  }
  return out;
}
