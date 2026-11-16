/**
 * Wreck re-split in a real room (salvage stream PR 5/6, capital-destruction.md
 * §S4 "Re-split"): a shell kills a heavy cruiser, then hits through the room's
 * damage choke point (`applyDamage`, which hands the weapon to
 * `onWreckHit`) wear its biggest piece's hidden integrity until it splits.
 * The child wreck's pieces are real worker bodies built from the descriptor
 * chain the client resolves; the parent descriptor stays on the wire. An
 * ordinary gun needs 10× the damage of a factor-1 (mining-like) weapon, and
 * grinding the smallest piece ends in a `salvage` loot pod.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { WEAPONS } from '../../../src/core/combat/WeaponCatalogue.js';
import { wreckChildGeometry, wreckChildSeed } from '../../../src/core/destruction/wreckChildren.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';

describe('SectorRoom integration: wreck pieces wear down and re-split', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    delete WEAPONS.get('laser')!.targetFactor;
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a worn-out piece splits into a child wreck; ordinary guns wear 10x slower; a small one turns to salvage', async () => {
    const kind = getShipKind(KIND);
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, pilotCapitals: true,
    });
    const victim = randomUUID();
    await harness.connectActive(victim, { shipKind: KIND, spawnX: 8000, spawnY: 0, initialHull: 1, initialShield: 0 });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    internal.setWreckSeed(5);
    await harness.advance(150);
    const pose = internal.playerPose(victim)!;
    const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
    internal.spawnTestProjectile('bb-shooter', pose.x + kind.radius * 0.6 * c, pose.y + kind.radius * 0.6 * s, -c * 3000, -s * 3000, 'naval_xl', 1400);
    for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
    const root = internal.wreckDescriptors()[0]!;
    expect(root, 'the shell killed the cruiser and it broke up').toBeDefined();
    await harness.advance(WRECK_CRACK_MS + 500);

    const pieces = () => [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    const size = (id: string) => internal.wreckIntegrity(id) ?? 0;
    const big = pieces().reduce((a, b) => (size(b.id) > size(a.id) ? b : a));
    const iMax = internal.wreckIntegrity(big.id)!;
    expect(iMax).toBeGreaterThan(0);

    // An ordinary gun (laser, wreck factor 0.1) wears a tenth of its damage.
    const at = internal.wreckState(big.id)!;
    internal.applyDamage(big.id, 'bb-shooter', 3 * iMax, at.x - 1, at.y, 1, 0, 'laser');
    expect(internal.wreckIntegrity(big.id)!).toBeCloseTo(0.7 * iMax, 3);
    // The same weapon at factor 1 (a stand-in for the mining laser) wears it all.
    WEAPONS.get('laser')!.targetFactor = { wreck: 1 };
    internal.applyDamage(big.id, 'bb-shooter', 0.3 * iMax, at.x - 1, at.y, 1, 0, 'laser');
    expect(internal.wreckIntegrity(big.id)!).toBeCloseTo(0.4 * iMax, 3);

    // Wear it out: it splits.
    const now = internal.wreckState(big.id)!;
    internal.applyDamage(big.id, 'bb-shooter', iMax, now.x - 1, now.y, 1, 0, 'laser');
    expect(internal.swarmRegistry.get(big.id) ?? null, 'the worn-out piece left').toBeNull();
    const descs = internal.wreckDescriptors();
    const child = descs.find((d) => d.parentWreck === root.wreckId)!;
    expect(child, 'a child wreck names the root').toBeDefined();
    expect(descs.some((d) => d.wreckId === root.wreckId), 'the root descriptor stays').toBe(true);
    expect(child.seed).toBe(wreckChildSeed(root.seed, child.parentPiece!));
    await harness.advance(100);
    const kids = pieces().filter((r) => r.wreckId === child.wreckId);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    // The bodies are the chain's geometry (what the client rebuilds, #15).
    const geom = wreckChildGeometry({
      root: {
        kindId: root.parentKind as ShipKindId, seed: root.seed, killX: root.killX, killY: root.killY,
        killBlowDamage: root.killBlowDamage, recentDamageRate: root.recentDamageRate, snapChance: root.snapChance,
        cutKind: root.cutKind, cutAng: root.cutAng, cutW: root.cutW,
      },
      steps: [{ pieceIndex: child.parentPiece!, killX: child.killX, killY: child.killY, cutKind: child.cutKind, cutAng: child.cutAng, cutW: child.cutW }],
    });
    for (const k of kids) {
      const g = geom.find((x) => x.index === k.componentIndex)!;
      expect(internal.wreckParts(k.id)).toEqual(g.parts);
    }
    console.log(`[wreck resplit] ${KIND} piece ${big.id} (I_max ${iMax.toFixed(0)}) split into ${kids.length} pieces of wreck ${child.wreckId}`);

    // Grind the smallest pieces until one is too small to split: a salvage pod.
    const pods0 = internal.loot.podCount();
    for (let i = 0; i < 60 && internal.loot.podCount() === pods0; i++) {
      const small = pieces().reduce((a, b) => (size(b.id) < size(a.id) ? b : a));
      const p = internal.wreckState(small.id)!;
      internal.applyDamage(small.id, 'bb-shooter', internal.wreckIntegrity(small.id)! + 1, p.x - 1, p.y, 1, 0, 'laser');
      await harness.advance(20);
    }
    expect(internal.loot.podCount(), 'a salvage pod dropped').toBe(pods0 + 1);
    const pod = [...internal.loot.podIds()][0]!;
    expect(internal.loot.shipHold(pod)?.goods.salvage ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
