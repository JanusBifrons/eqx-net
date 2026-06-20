/**
 * MountVisualManager — dynamic weapon mounts cluster lock (Phase 4 WS-B3, plan:
 * effervescent-umbrella, invariant #13).
 *
 * `ensureForInstance` builds a turret cluster for a ship's FULL per-instance
 * mount list `[...kind.mounts, ...activated latent]`. When a player ACTIVATES a
 * latent mount the `kindId` is unchanged but the mount list grows — the cluster
 * must REBUILD (the new barrel must appear). The legacy `ensureForShip`
 * (kind-only) idempotency check can't detect that, so `ensureForInstance` keys
 * on a per-instance `mountSig`.
 *
 * Reads the REAL drawn artifact (`mountCountForShip` — the per-mount Graphics
 * count), not a recompute (feedback-test-observable lesson).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { resolveInstanceMounts } from '../../shared-types/shipKinds/slots.js';
import { shipPrimaryColor } from '@core/geometry/shipHullOutline';

const FIGHTER = getShipKind('fighter');

function sig(activated: Array<{ slotId: string; weaponId: string }>): string {
  let s = '';
  for (const a of activated) s += a.slotId + '|' + a.weaponId + ';';
  return s;
}

describe('MountVisualManager — dynamic mounts (WS-B3)', () => {
  let mgr: MountVisualManager;
  let parent: Container;
  beforeEach(() => {
    mgr = new MountVisualManager();
    parent = new Container();
  });

  it('ensureForInstance builds a cluster with the base mounts when un-upgraded', () => {
    const mounts = resolveInstanceMounts(FIGHTER, []);
    mgr.ensureForInstance('p1', 'fighter', mounts, shipPrimaryColor(FIGHTER), sig([]), parent);
    // Fighter has 1 base mount, 0 activated.
    expect(mgr.mountCountForShip('p1')).toBe(FIGHTER.mounts!.length);
  });

  it('REBUILDS the cluster to add the extra barrel when a latent mount activates', () => {
    // Start un-upgraded.
    mgr.ensureForInstance('p1', 'fighter', resolveInstanceMounts(FIGHTER, []), shipPrimaryColor(FIGHTER), sig([]), parent);
    const base = FIGHTER.mounts!.length;
    expect(mgr.mountCountForShip('p1')).toBe(base);

    // Activate one latent wing mount — the cluster must rebuild with +1 barrel.
    const activated = [{ slotId: 'latent-wing-l', weaponId: 'laser' }];
    mgr.ensureForInstance('p1', 'fighter', resolveInstanceMounts(FIGHTER, activated), shipPrimaryColor(FIGHTER), sig(activated), parent);
    expect(mgr.mountCountForShip('p1')).toBe(base + 1);
  });

  it('is idempotent for an unchanged activated set (no rebuild)', () => {
    const activated = [{ slotId: 'latent-wing-r', weaponId: 'hitscan' }];
    const mounts = resolveInstanceMounts(FIGHTER, activated);
    const c1 = mgr.ensureForInstance('p1', 'fighter', mounts, shipPrimaryColor(FIGHTER), sig(activated), parent);
    const c2 = mgr.ensureForInstance('p1', 'fighter', mounts, shipPrimaryColor(FIGHTER), sig(activated), parent);
    expect(c2).toBe(c1); // same container instance — no rebuild
    expect(mgr.mountCountForShip('p1')).toBe(FIGHTER.mounts!.length + 1);
  });

  it('rebuilds when the activated set changes (a second mount activates)', () => {
    const one = [{ slotId: 'latent-wing-l', weaponId: 'laser' }];
    mgr.ensureForInstance('p1', 'fighter', resolveInstanceMounts(FIGHTER, one), shipPrimaryColor(FIGHTER), sig(one), parent);
    expect(mgr.mountCountForShip('p1')).toBe(FIGHTER.mounts!.length + 1);

    const two = [...one, { slotId: 'latent-wing-r', weaponId: 'laser' }];
    mgr.ensureForInstance('p1', 'fighter', resolveInstanceMounts(FIGHTER, two), shipPrimaryColor(FIGHTER), sig(two), parent);
    expect(mgr.mountCountForShip('p1')).toBe(FIGHTER.mounts!.length + 2);
  });
});
