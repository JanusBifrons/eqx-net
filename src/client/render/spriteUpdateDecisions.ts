/**
 * Phase A3 — pure decision logic for per-entity sprite updates.
 *
 * Extracted from `PixiRenderer.updateLingeringShips` and
 * `PixiRenderer.updateWrecks` to make the decisions testable WITHOUT
 * a Pixi runtime. The Pixi calls (Graphics instantiation, addChild,
 * tint, alpha, destroy) remain in `PixiRenderer.ts`; only the
 * "should I create / rebuild / reposition / skip" branching lives
 * here.
 *
 * **The bug class this catches**: the Phase 6b lingering hull was
 * permanently invisible because `updateLingeringShips` had a
 * `if (!ship.kind) continue;` guard — a defensive-looking check that
 * silently dropped every frame when the schema diff with `kind` hadn't
 * landed yet. A unit test on the pure helper would have failed
 * loudly: "kind-unknown with no cache should `create` with the
 * fallback kind, not `skip`." This module makes that contract
 * explicit and testable.
 *
 * **The rule** (per `src/client/CLAUDE.md`): renderer per-entity
 * decision logic must live here and be unit-tested. Pixi calls stay
 * in `PixiRenderer.ts` but should be a thin shell over this module's
 * outputs.
 */

/** What the renderer should do this frame for one entity. */
export type SpriteDecision =
  | { action: 'create';     kind: string }
  | { action: 'rebuild';    kind: string }
  | { action: 'reposition' }
  | { action: 'skip';       reason: string };

/** What the renderer remembers about a previously-built sprite. */
export interface SpriteCacheEntry {
  /** The kind the sprite was built with. Comparison key for rebuilds. */
  kind: string;
}

/**
 * Phase 6b lingering-hull decision.
 *
 * Rules:
 *  - **No cache hit**: build a new sprite. Use `currentKind` if
 *    available; fall back to `fallbackKind` if the kind hasn't been
 *    populated yet (the schema diff may arrive after the first
 *    snapshot). Use of the fallback is the bug-fix from the Phase 6b
 *    "invisible after snapshot" incident — we'd rather show the wrong
 *    silhouette for one frame than nothing at all.
 *  - **Cache hit with same kind**: just reposition this frame.
 *  - **Cache hit with different known kind**: rebuild the sprite to
 *    pick up the new silhouette.
 *  - **Cache hit with unknown current kind**: reposition. Don't
 *    rebuild on a transient field drop — the previously-known kind
 *    is still our best information.
 */
export function decideLingeringSpriteAction(args: {
  cached: SpriteCacheEntry | undefined;
  currentKind: string | undefined;
  fallbackKind: string;
}): SpriteDecision {
  const { cached, currentKind, fallbackKind } = args;
  if (!cached) {
    return { action: 'create', kind: currentKind ?? fallbackKind };
  }
  // Cache hit. Decide based on whether the current kind matches.
  if (currentKind && currentKind !== cached.kind) {
    return { action: 'rebuild', kind: currentKind };
  }
  return { action: 'reposition' };
}

/**
 * Phase 4 wreck decision. Similar rules to lingering but with one
 * important difference: a wreck's kind is REQUIRED. The schema's
 * `WreckState` always carries `kind` (set at conversion time) so we
 * never expect undefined here. If it does arrive undefined, that's a
 * server-side wire-format break — surface a `skip` with a reason so
 * the bug shows up in a log instead of as a missing sprite.
 */
export function decideWreckSpriteAction(args: {
  cached: SpriteCacheEntry | undefined;
  currentKind: string | undefined;
}): SpriteDecision {
  const { cached, currentKind } = args;
  if (!currentKind) {
    return { action: 'skip', reason: 'wreck-kind-missing-from-schema' };
  }
  if (!cached) {
    return { action: 'create', kind: currentKind };
  }
  if (cached.kind !== currentKind) {
    return { action: 'rebuild', kind: currentKind };
  }
  return { action: 'reposition' };
}

/**
 * Position lookup for an explosion VFX spawn.
 *
 * Bug repro (2026-05-13 user smoke-test): when a lingering hull was
 * shot down, the explosion VFX rendered at (0, 0) instead of the
 * hull's actual position. Root cause: the renderer only checked the
 * **active-ships** sprite map (keyed by playerId), but lingering
 * hulls live in `lingeringSprites` (keyed by shipInstanceId) and
 * wrecks live in `wreckSprites`. Lookup failed → defaulted to
 * `(0, 0)`.
 *
 * This helper looks up the targetId across ALL three sprite maps
 * (active ships, lingering hulls, wrecks) so the explosion spawns
 * over whichever silhouette was visible to the player at the moment
 * of destruction.
 *
 * Returns `null` if no sprite is found in any map — the caller can
 * decide whether to skip the VFX entirely or fall back somewhere
 * sensible (rather than the silent (0, 0) of the previous
 * implementation).
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
  activeShipsByPlayerId: ReadonlyMap<string, SpritePoseRef>;
  lingeringShipsByShipInstanceId: ReadonlyMap<string, SpritePoseRef>;
  wrecksByShipInstanceId: ReadonlyMap<string, SpritePoseRef>;
}): SpritePoseRef | null {
  const { targetId, activeShipsByPlayerId, lingeringShipsByShipInstanceId, wrecksByShipInstanceId } = args;
  const active = activeShipsByPlayerId.get(targetId);
  if (active) return { x: active.x, y: active.y };
  const lingering = lingeringShipsByShipInstanceId.get(targetId);
  if (lingering) return { x: lingering.x, y: lingering.y };
  const wreck = wrecksByShipInstanceId.get(targetId);
  if (wreck) return { x: wreck.x, y: wreck.y };
  return null;
}
