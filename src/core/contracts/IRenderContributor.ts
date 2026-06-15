/**
 * IRenderContributor — declares HOW an entity becomes a client render-mirror
 * entry. Phase 3 generalises the client construction path (`entityFactory`)
 * off this descriptor.
 *
 * The load-bearing field here is `preservedFields`. The client rebuilds the
 * render mirror every 60 Hz frame; the 2026-05-27 "invisible hull" bug was a
 * non-spatial field (kind / shield-down) being dropped on rebuild. Declaring
 * preserved fields per kind, descriptor-driven, defuses that trap generically
 * — there is no per-leaf list to forget at each of the two rebuild sites.
 *
 * Zone-pure (src/core): the actual sprite/mirror mutation is a client
 * concretion injected in Phase 3; this only declares the contract.
 */

export interface RenderContribution {
  /** Which render-mirror bucket this entity lives in
   *  (e.g. 'ships' | 'lingeringShips' | 'swarm' | 'structures'). */
  readonly bucket: string;
  /** Non-spatial mirror fields that MUST survive the per-frame rebuild
   *  (e.g. ['kind'] / ['shieldDown'] / ['displayName']). Empty when none. */
  readonly preservedFields: readonly string[];
  /** True if the renderer display-interpolates this entity's pose. Mirrors
   *  `SyncProfile.interpolated` but is read by the render path, not the wire. */
  readonly interpolated: boolean;
}

export interface IRenderContributor {
  /** The (stable, per-kind) render descriptor for this entity. */
  renderContribution(): RenderContribution;
}
