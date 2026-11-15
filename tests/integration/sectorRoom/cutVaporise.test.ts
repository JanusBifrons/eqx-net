/**
 * Fracture v11 on the real server (owner 2026-11-15): when a cut weapon
 * (heavy-beam slice, railgun channel) kills a ship, any piece too small
 * burns away; with none left the ship is VAPORISED. Same rule for every
 * ship, AI pilot or player.
 *
 * Drives the real chain: `applyDamage` with the heavy beam's weapon id and
 * the shot's direction → DamageRouter → the death policy (drone: before the
 * eviction's broadcast; active hull: before its own) → the wreck subsystem →
 * `destroy` on the wire with `vaporised: true` and no wreck. A heavy cruiser
 * sliced by the same beam keeps its hulks and an ordinary `destroy`.
 * capital-destruction.md "Kill cuts", "Burn-away".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DestroyEvent } from '../../../src/shared-types/messages.js';
import { DestroyEventSchema } from '../../../src/shared-types/messages.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { shipShapeScale } from '../../../src/core/geometry/shipHullOutline.js';

const WRECK_KIND = 4;

describe('SectorRoom integration — a cut kill vaporises what it burns away (fracture v11)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  type Internals = SectorRoom['_internals'];

  async function boot(): Promise<{ int: Internals; destroys: DestroyEvent[] }> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, subcapWrecks: true,
    });
    const observer = await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -40_000, spawnY: -40_000 });
    const destroys: DestroyEvent[] = [];
    observer.onMessage('destroy', (m: DestroyEvent) => destroys.push(m));
    return { int: (harness.getServerRoom() as unknown as SectorRoom)._internals, destroys };
  }

  /** A heavy-beam shot across the hull from its starboard side at
   *  mid-length (hull 1x frame +x; `halfBeam` 1x units out). */
  function sideShot(kind: ShipKindId, x: number, y: number, angle: number, halfBeam: number) {
    const s = shipShapeScale(getShipKind(kind));
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    return { hitX: x + halfBeam * s * c, hitY: y + halfBeam * s * sn, dirX: -c, dirY: -sn };
  }

  async function wireDestroy(destroys: DestroyEvent[], targetId: string): Promise<DestroyEvent> {
    for (let t = 0; t < 20; t++) {
      const d = destroys.find((m) => m.targetId === targetId);
      if (d !== undefined) return d;
      await harness.advance(50);
    }
    throw new Error(`no destroy for ${targetId}`);
  }

  it('heavy beam: a fighter, a gunship and a missile frigate (across) are vaporised; a heavy cruiser keeps its hulks', async () => {
    const { int, destroys } = await boot();
    const cases: Array<[string, ShipKindId, number, boolean]> = [
      ['f1', 'fighter', 10, true],
      ['g1', 'gunship', 10, true],
      ['mf1', 'missile-frigate', 16, true],
      ['hc1', 'heavy-cruiser', 227, false],
    ];
    let x = 6000;
    for (const [id, kind, halfBeam, vaporised] of cases) {
      // Entity ids are recycled: only this kill's event counts.
      destroys.length = 0;
      expect(int.spawnTestDrone(id, x, 0, kind)).toBe(true);
      x += 8000;
      await harness.advance(100);
      const entityId = int.swarmRegistry.get(id)!.entityId;
      const descBefore = int.wreckDescriptors().length;
      const at = int.wreckState(id)!;
      const shot = sideShot(kind, at.x, at.y, at.angle, halfBeam);
      expect(int.applyDamage(id, 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(true);
      expect(int.swarmRegistry.get(id), `${kind}: the ship is gone`).toBeFalsy();
      const d = await wireDestroy(destroys, `swarm-${entityId}`);
      expect(DestroyEventSchema.safeParse(d).success, `${kind}: a valid destroy`).toBe(true);
      const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND && r.shipKind === kind);
      if (vaporised) {
        expect(d.vaporised, `${kind}: vaporised`).toBe(true);
        expect(pieces, `${kind}: no wreck`).toHaveLength(0);
        expect(int.wreckDescriptors().length, `${kind}: no descriptor`).toBe(descBefore);
      } else {
        expect(d.vaporised, `${kind}: not vaporised`).toBeUndefined();
        expect(pieces.length, `${kind}: its hulks drift on`).toBeGreaterThanOrEqual(2);
      }
    }
  }, 30_000);

  it('a player-flown fighter killed by the heavy beam is vaporised too (ships, not pilots)', async () => {
    const { int, destroys } = await boot();
    const pid = randomUUID();
    await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 5000, spawnY: 0 });
    await harness.advance(100);
    const at = int.wreckState(pid);
    const pose = at ?? { x: 5000, y: 0, angle: 0 };
    const shot = sideShot('fighter', pose.x, pose.y, pose.angle, 10);
    // The shield takes the first hit whole (no spill-over); the second kills.
    expect(int.applyDamage(pid, 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(false);
    expect(int.applyDamage(pid, 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(true);
    const d = await wireDestroy(destroys, pid);
    expect(d.vaporised).toBe(true);
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    expect(pieces).toHaveLength(0);
  }, 30_000);
});
