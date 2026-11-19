/**
 * Dev / diagnostic contact probes of `PhysicsWorld` (World.ts): what a body
 * is touching right now, read from Rapier's narrow phase. Moved verbatim out
 * of World.ts (god-file split); `PhysicsWorld.fastestContact` and
 * `PhysicsWorld.queryContactState` are one-line delegates, so the API is
 * unchanged. Not on any hot path (the wake census and the ramming probe
 * only), so these may allocate.
 */
import type RAPIER from '@dimforge/rapier2d-compat';

/** `PhysicsWorld.queryContactState`'s result (see its doc). */
export interface ContactState {
  normal: { x: number; y: number };
  penetration: number;
  impulse: number;
  contactCount: number;
  otherBodyId: string | null;
}

/** `PhysicsWorld.fastestContact` for a live body (see its doc). */
export function fastestContact(
  world: RAPIER.World,
  handleToId: ReadonlyMap<number, string>,
  body: RAPIER.RigidBody,
): { otherId: string; speed: number } | null {
  const np = world.narrowPhase;
  let best: { otherId: string; speed: number } | null = null;
  const numCol = body.numColliders();
  for (let ci = 0; ci < numCol; ci++) {
    const col = body.collider(ci);
    if (!col) continue;
    np.contactPairsWith(col.handle, (otherHandle) => {
      let live = false;
      np.contactPair(col.handle, otherHandle, (manifold) => { if (manifold.numContacts() > 0) live = true; });
      if (!live) return;
      const parent = world.getCollider(otherHandle)?.parent();
      if (!parent) return;
      const otherId = handleToId.get(parent.handle);
      if (otherId === undefined) return;
      const v = parent.linvel();
      const speed = Math.hypot(v.x, v.y);
      if (best === null || speed > best.speed) best = { otherId, speed };
    });
  }
  return best;
}

/**
 * Behind `PhysicsWorld.queryContactState` (World.ts).
 *
 * Diagnostic-only — inspect Rapier's resolved contact state for a body's
 * colliders. Iterates every contact pair the body participates in and
 * returns the deepest contact with the largest impulse, plus the contact
 * normal direction. Used by the ramming probe to surface why the resolver
 * is settling at non-zero penetration under continuous thrust.
 *
 * Returns null if the body has no contacts this step.
 */
export function queryContactState(
  world: RAPIER.World,
  handleToId: ReadonlyMap<number, string>,
  body: RAPIER.RigidBody,
): ContactState | null {
  const np = world.narrowPhase;
  let bestNormal = { x: 0, y: 0 };
  let bestPenetration = 0;
  let bestImpulse = 0;
  let totalContacts = 0;
  let bestOtherId: string | null = null;
  const numCol = body.numColliders();
  for (let ci = 0; ci < numCol; ci++) {
    const col = body.collider(ci);
    if (!col) continue;
    np.contactPairsWith(col.handle, (otherHandle) => {
      np.contactPair(col.handle, otherHandle, (manifold, flipped) => {
        const n = manifold.normal();
        const count = manifold.numContacts();
        totalContacts += count;
        for (let i = 0; i < count; i++) {
          const dist = manifold.contactDist(i);
          const imp = manifold.contactImpulse(i);
          const pen = -dist;
          if (pen > bestPenetration) {
            bestPenetration = pen;
            bestNormal = flipped ? { x: -n.x, y: -n.y } : { x: n.x, y: n.y };
            bestImpulse = imp;
            const otherCol = world.getCollider(otherHandle);
            const otherParent = otherCol?.parent();
            if (otherParent) {
              bestOtherId = handleToId.get(otherParent.handle) ?? null;
            }
          }
        }
      });
    });
  }
  if (totalContacts === 0) return null;
  return {
    normal: bestNormal,
    penetration: bestPenetration,
    impulse: bestImpulse,
    contactCount: totalContacts,
    otherBodyId: bestOtherId,
  };
}
