/**
 * The Capital crate carries its bank: a fresh crate holds 5,000 minerals, a
 * repacked one holds whatever the Capital's bank had. Pack / unpack never
 * prints minerals, and goods stored in the Capital are never lost.
 */
import { describe, it, expect } from 'vitest';
import {
  StructurePlacementSubsystem,
  capitalCrateItem,
  packedGateForBuild,
  repackItem,
  type PackedGateHost,
} from './StructurePlacementSubsystem.js';
import { StructureRegistry } from './StructureRegistry.js';
import { StorageService } from '../cargo/StorageService.js';
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { addPacked, emptyHold } from '../../core/cargo/hold.js';
import type { Hold } from '../../shared-types/goods.js';
import type { HoldRecord, HoldStore } from '../cargo/HoldStore.js';

/** A placement subsystem whose crates come from one ship hold, through the
 *  room's real `packedGateForBuild`. */
function world(hold: Hold) {
  const registry = new StructureRegistry();
  const base: HoldRecord = {
    holderUid: 'ship-1', holderType: 'ship', ownerId: 'alice', sectorKey: 'A1', x: null, y: null, hold, expiresAt: null,
  };
  let row: HoldRecord | undefined = base;
  const holdStore = {
    get: () => row,
    commit: (puts: HoldRecord[], dels: string[]) => { row = dels.length > 0 ? undefined : puts[0]; },
  } as unknown as HoldStore;
  const host: PackedGateHost = {
    storage: () => ({ commitChanged: () => {} }) as unknown as StorageService,
    holdStore: () => holdStore,
    sectorKey: () => 'A1',
    findPacked: (_o, product) => ((row?.hold.packed ?? []).some((p) => p.product === product) ? { shipId: 'ship-1' } : null),
  };
  let n = 0;
  const sub = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: () => {},
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`,
    registry,
    sectorKey: () => 'A1',
    packedGateForBuild: (owner, kind) => packedGateForBuild(host, owner, kind),
  });
  /** The ship's hold (an emptied hold's row is deleted; this re-creates it). */
  const shipHold = (): Hold => (row ??= { ...base, hold: emptyHold() }).hold;
  return { sub, registry, shipHold };
}

const placeCapital = (w: ReturnType<typeof world>, x: number) =>
  w.registry.get(w.sub.place('alice', 'capital', x, 0, { requirePacked: true })!)!;

describe('the Capital crate carries its bank', () => {
  it('a fresh crate holds 5,000', () => {
    expect(capitalCrateItem(50, CAPITAL_STARTING_MINERALS).minerals).toBe(5000);
    // A crate from the blueprint line (no bank written) is a fresh one too.
    const h = emptyHold();
    addPacked(h, 'structure:capital', 50);
    expect(placeCapital(world(h), 0).minerals).toBe(5000);
  });

  it('unpack, repack, unpack does not add minerals', () => {
    const w = world({ goods: {}, blueprints: [], packed: [capitalCrateItem(50, 5000)] });
    const cap = placeCapital(w, 0);
    expect(cap.minerals).toBe(5000);
    expect(w.shipHold().packed ?? []).toHaveLength(0);
    cap.minerals = 1200; // spent on builds
    // Repack (deconstruct): the crate takes the bank, the Capital keeps none.
    const crate = repackItem(cap, 50);
    expect(crate.minerals).toBe(1200);
    expect(crate.uid).toMatch(/^cap-/);
    expect(cap.minerals).toBe(0);
    w.registry.remove(cap.id);
    (w.shipHold().packed ??= []).push(crate);
    // Unpack again: the one-of-a-kind crate is used and its bank comes back.
    const again = placeCapital(w, 0);
    expect(again.minerals).toBe(1200);
    expect(w.shipHold().packed ?? []).toHaveLength(0);
  });

  it('several Capitals each keep their own bank (a looted crate works the same)', () => {
    const w = world({ goods: {}, blueprints: [], packed: [capitalCrateItem(50, 300), capitalCrateItem(50, 900)] });
    const banks = [placeCapital(w, 0).minerals, placeCapital(w, 8000).minerals].sort((a, b) => a - b);
    expect(banks).toEqual([300, 900]);
  });

  it('goods stored in a packed Capital are not lost', () => {
    // Repack writes the bank into the crate; the Capital's goods stay in its
    // hold, and the despawn spill (`takeForSpill` = `payloadOf`) drops them as
    // a pod where it stood: nothing lost, and the bank is not spilled twice.
    const registry = new StructureRegistry();
    const w = world({ goods: {}, blueprints: [], packed: [capitalCrateItem(50, 5000)] });
    const cap = placeCapital(w, 0);
    cap.minerals = 2500;
    cap.hold = { goods: { ice: 30, minerals: 40 }, blueprints: [] };
    const crate = repackItem(cap, 50);
    const storage = new StorageService({ holdStore: {} as HoldStore, registry, sectorKey: () => null, componentOf: () => [] });
    const spill = storage.payloadOf(cap);
    expect(crate.minerals).toBe(2500);
    expect(spill.goods).toEqual({ ice: 30, minerals: 40 });
  });

  it('a non-Capital repacks as a plain crate (no bank, no uid)', () => {
    const w = world(emptyHold());
    const rec = w.registry.get(w.sub.place('alice', 'solar', 0, 0)!)!;
    rec.packedQuality = 70;
    expect(repackItem(rec, 50)).toEqual({ product: 'structure:solar', quality: 70 });
  });
});
