/**
 * Shield-fence plan — the shield wall through the real SectorRoom (the "new
 * visible entity ⇒ integration test through the full path" mandate). Seeds two
 * pre-built, connected `shield_pylon`s and asserts the wall the manager forms is
 * surfaced on the `structures[]` snapshot slice (shieldWallTo + wallActive), then
 * that it drops on power loss and tears down when a pylon is destroyed. The
 * grid-power/stun hit model + the weapon-vs-wall geometry are locked at the unit
 * level (ShieldWallManager / ShieldWall); this locks the server WIRING + wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

type Slice = NonNullable<SnapshotMessage['structures']>;
const entry = (slice: Slice | undefined, id: number): Slice[number] | undefined =>
  slice?.find((s) => s.id === id);

describe('SectorRoom integration — shield fence (shield-fence plan)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  /** Capital + two pylons positioned so A links the capital and B links A
   *  (so both are powered AND the A↔B pair forms a wall). */
  async function bootFence() {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'shield_pylon', x: 250, y: 0 },
        { kind: 'shield_pylon', x: 250, y: 240 },
      ],
    });
    await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    const pylons = [...internals.structureRegistry.all()].filter((r) => r.kind === 'shield_pylon');
    const eidOf = (sid: string): number => internals.swarmRegistry.get(sid)!.entityId;
    return { internals, pylons, eidOf };
  }

  it('two connected pylons project a powered, ACTIVE wall surfaced on the slice', async () => {
    const { internals, pylons, eidOf } = await bootFence();
    expect(pylons).toHaveLength(2);
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    const slice = internals.getStructuresSlice();
    const ea = eidOf(pylons[0]!.id);
    const eb = eidOf(pylons[1]!.id);
    const a = entry(slice, ea)!;
    expect(a.shieldWallTo).toBe(eb);
    expect(a.wallActive).toBe(true);
    expect(entry(slice, eb)?.shieldWallTo).toBe(ea); // reciprocal on the pair
  }, 25_000);

  it('losing grid power drops the wall to inactive (still formed)', async () => {
    const { internals, pylons, eidOf } = await bootFence();
    for (let i = 0; i < 2; i++) internals.pulseStructureGrid();
    const cap = [...internals.structureRegistry.all()].find((s) => s.kind === 'capital')!;
    internals.applyDamage(cap.id, 'player-1', 999_999); // destroy the capital → no power
    for (let i = 0; i < 2; i++) internals.pulseStructureGrid();
    const a = entry(internals.getStructuresSlice(), eidOf(pylons[0]!.id))!;
    expect(a.shieldWallTo).toBeDefined(); // the pair is still connected
    expect(a.wallActive).toBe(false); // but unpowered → down (passable)
  }, 25_000);

  it('destroying a pylon tears the wall down', async () => {
    const { internals, pylons, eidOf } = await bootFence();
    for (let i = 0; i < 2; i++) internals.pulseStructureGrid();
    const survivor = eidOf(pylons[1]!.id);
    internals.applyDamage(pylons[0]!.id, 'player-1', 999_999); // destroy one pylon
    for (let i = 0; i < 2; i++) internals.pulseStructureGrid();
    // The survivor no longer projects a wall (its pair is gone).
    expect(entry(internals.getStructuresSlice(), survivor)?.shieldWallTo).toBeUndefined();
  }, 25_000);
});
