/**
 * Phase A3 — pure decision logic for per-entity sprite updates.
 *
 * Extracted from the renderer to make the decisions testable WITHOUT a Pixi
 * runtime. The Pixi calls (Graphics instantiation, addChild, tint, destroy)
 * remain in the renderer; only the "should I create / rebuild / reposition"
 * branching lives here.
 *
 * **The bug class this catches**: the Phase 6b parked hull was permanently
 * invisible because its updater had a `if (!ship.kind) continue;` guard — a
 * defensive-looking check that silently dropped every frame when the schema
 * diff with `kind` hadn't landed yet. "kind-unknown with no cache should
 * `create` with the fallback kind, not `skip`" is now an explicit contract.
 *
 * **The rule** (per `src/client/CLAUDE.md`): renderer per-entity decision
 * logic must live here and be unit-tested.
 */

/** What the renderer should do this frame for one ship sprite. Constant
 *  strings (no allocation: called per ship per frame, #14). */
export type ShipSpriteAction = 'create' | 'rebuild' | 'reposition';

/**
 * The ship-sprite decision for EVERY ship (RTS Part A S3: generalised from
 * the old parked-hull decision, so a parked / AI-flown hull and an active ship
 * share one path). `cachedKind` is the kind the cached sprite was built for
 * (undefined = no sprite yet).
 *
 * Rules:
 *  - **No cached sprite**: build one, with `currentKind` if known, else the
 *    fallback kind (`shipSpriteKind`): show the wrong silhouette for a frame
 *    rather than nothing (the Phase 6b "invisible after snapshot" incident).
 *  - **Cached, same kind**: reposition.
 *  - **Cached, a DIFFERENT known kind**: rebuild for the new silhouette.
 *  - **Cached, current kind unknown**: reposition — a transient field drop
 *    must not rebuild; the cached kind is still the best information.
 */
export function decideShipSpriteAction(cachedKind: string | undefined, currentKind: string | undefined): ShipSpriteAction {
  if (cachedKind === undefined) return 'create';
  if (currentKind !== undefined && currentKind !== cachedKind) return 'rebuild';
  return 'reposition';
}

/** The kind a ship sprite is (re)built or kept as: the entry's kind, else the
 *  kind the cached sprite already shows, else the fallback. */
export function shipSpriteKind(cachedKind: string | undefined, currentKind: string | undefined, fallbackKind: string): string {
  return currentKind ?? cachedKind ?? fallbackKind;
}

/**
 * Position lookup for an explosion VFX spawn.
 *
 * Bug repro (2026-05-13 user smoke-test): when a parked hull was shot down,
 * the explosion VFX rendered at (0, 0) instead of the hull's position: its
 * sprite lived in a separate map the lookup didn't check. Since RTS Part A S3
 * every ship's sprite is in ONE map (active ships by playerId, parked hulls by
 * shipInstanceId); the dying ship's mirror entry is already gone, so the pose
 * comes from its sprite.
 *
 * Returns `null` if no sprite is found — the caller skips the VFX (never the
 * silent (0, 0) of the original implementation).
 */
export interface SpritePoseRef {
  /** World-space (or Pixi container-space) x. */
  x: number;
  /** Pixi container-space y. The renderer uses negative-world-y for Pixi-y
   *  flip; callers should keep whatever convention their sprite maps use. */
  y: number;
}

export function decideExplosionPosition(args: {
  targetId: string;
  shipSprites: ReadonlyMap<string, SpritePoseRef>;
}): SpritePoseRef | null {
  const sp = args.shipSprites.get(args.targetId);
  // TODO: alloc-debt — one {x,y} per destroyed ship (discrete event, not per frame).
  if (sp) return { x: sp.x, y: sp.y };
  return null;
}

/**
 * A3 (plan soft-leaping-truffle v2) — is a sprite at pixi-space (x, y) with
 * bounding radius `r` inside the camera's visible rect `[minX, minY, maxX,
 * maxY]` (`Camera.visibleBoundsInto`)? Used to stop drawing off-screen
 * structures (a citadel is ~450 retained Graphics). No bounds ⇒ visible.
 */
export function isSpriteInView(x: number, y: number, r: number, bounds: Float64Array | undefined): boolean {
  if (!bounds) return true;
  return x + r >= bounds[0]! && x - r <= bounds[2]! && y + r >= bounds[1]! && y - r <= bounds[3]!;
}

/**
 * Machined art (plan iridescent-seeking-rainbow, A3): should a ship's cached
 * sprite be rebuilt this frame?
 *  - art off, no handle, or the bake failed ⇒ today's vector look;
 *  - handle pending ⇒ keep whatever is shown (vector until the first art lands;
 *    an old Machined sprite keeps drawing while a re-paint bakes);
 *  - handle ready ⇒ the Machined sprite.
 * `showsHandleArt`: the cached sprite is the Machined sprite built from THIS
 * handle's art (an old Machined sprite of another paint does not count).
 * Returns a constant (no allocation: called per ship per frame, #14).
 */
export type ArtSwap = 'keep' | 'toMachined' | 'toClassic';

export function decideArtSwap(
  machinedOn: boolean,
  handleState: 'pending' | 'ready' | 'failed' | null,
  showsHandleArt: boolean,
): ArtSwap {
  if (!machinedOn || handleState === null || handleState === 'failed') return showsHandleArt ? 'toClassic' : 'keep';
  if (handleState === 'ready') return showsHandleArt ? 'keep' : 'toMachined';
  return 'keep';
}
