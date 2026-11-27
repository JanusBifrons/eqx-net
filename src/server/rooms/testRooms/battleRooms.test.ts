/**
 * Battle scenario rooms (battleRooms.ts): the owner's brief, locked.
 *  - every room is a sealed, empty, unsaved sector (no bases, turrets, rocks);
 *  - its script parses and fits the 64-entry seed guard;
 *  - the fleets START OUT OF RANGE of each other (no ship can reach any enemy
 *    hull at t = 0) but first contact comes within ~30 s at full closing speed
 *    ("they're just pulling into weapons range now").
 */
import { describe, it, expect, vi } from 'vitest';

// The real SectorRoom needs the schema decorators and a physics worker; the
// battle room only overrides onCreate, so a bare base stands in (as sandboxRoom.test).
const created: unknown[] = [];
vi.mock('../SectorRoom.js', () => ({
  SectorRoom: class {
    autoDispose = false;
    async onCreate(o: unknown): Promise<void> { created.push(o); }
  },
}));
const purged: string[] = [];
vi.mock('../../db/PersistenceWorker.js', () => ({
  getPlayerShipStore: () => ({ all: () => [{ shipId: 'old', lastSectorKey: 'battle-subcaps' }, { shipId: 'real', lastSectorKey: 'galaxy-a' }], delete: (id: string) => { purged.push(id); return true; } }),
  getHoldStore: () => ({ delete: () => undefined }),
}));
import { BATTLE_ROOMS, BATTLE_PILOT_KIND, BattleRoom, defineBattleRooms } from './battleRooms.js';
import { BATTLE_SECTOR_KEYS, isSealedSectorKey } from '../sealedSectors.js';
import { SceneScriptSchema } from '../scene/SceneScriptRunner.js';
import { MAX_SEED_ENTRIES } from '../roomSeedBounds.js';
import { getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { shipLockRange } from '../../../core/combat/mountReach.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../shared-types/sectorBounds.js';

interface Body { kind: ShipKindId; x: number; y: number; spread: number }

function sides(key: (typeof BATTLE_SECTOR_KEYS)[number]): { own: Body[]; enemy: Body[] } {
  const o = BATTLE_ROOMS[key];
  const steps = SceneScriptSchema.parse(o.sceneScript);
  const own: Body[] = [{ kind: BATTLE_PILOT_KIND[key], x: o.defaultSpawnX!, y: o.defaultSpawnY!, spread: 0 }];
  const enemy: Body[] = [];
  for (const s of steps) {
    if (s.action === 'fleet') own.push({ kind: s.kind as ShipKindId, x: s.x, y: s.y, spread: s.spread ?? 0 });
    if (s.action === 'spawn') enemy.push({ kind: s.kind as ShipKindId, x: s.x, y: s.y, spread: s.spread ?? 0 });
  }
  return { own, enemy };
}

/** Closest a shooter group can be to a target's hull at t = 0, and how long
 *  until the shooter's lock reach touches it at both sides' top speeds. */
function gap(a: Body, b: Body): { clear: number; contactS: number } {
  const centre = Math.hypot(a.x - b.x, a.y - b.y);
  const clear = centre - a.spread - b.spread - getShipKind(b.kind).radius - shipLockRange(getShipKind(a.kind));
  return { clear, contactS: clear / (getShipKind(a.kind).maxSpeed + getShipKind(b.kind).maxSpeed) };
}

describe('battle rooms', () => {
  it('cover every sealed battle key, and each key is sealed', () => {
    expect(Object.keys(BATTLE_ROOMS).sort()).toEqual([...BATTLE_SECTOR_KEYS].sort());
    for (const k of BATTLE_SECTOR_KEYS) expect(isSealedSectorKey(k)).toBe(true);
  });

  for (const key of BATTLE_SECTOR_KEYS) {
    describe(key, () => {
      const o = BATTLE_ROOMS[key];
      it('is an empty, sealed, unsaved sector whose script parses inside the seed guard', () => {
        expect(o.sectorKey).toBe(key);
        expect(o.sealed).toBe(true);
        expect(o.persistSector).toBe(false);
        expect(o.asteroidConfig).toEqual([]);
        expect(o.droneCount).toBe(0);
        expect(o.prebuiltStructures).toBeUndefined();
        expect(o.npcBases).toBeUndefined();
        expect((o.sceneScript as unknown[]).length).toBeLessThanOrEqual(MAX_SEED_ENTRIES);
        expect(() => SceneScriptSchema.parse(o.sceneScript)).not.toThrow();
      });

      it('starts with both fleets out of range, closing to contact within 30 s', () => {
        const { own, enemy } = sides(key);
        expect(own.length).toBeGreaterThan(1);
        expect(enemy.length).toBeGreaterThan(1);
        let firstContact = Infinity;
        for (const a of own) {
          for (const b of enemy) {
            for (const [s, t] of [[a, b], [b, a]] as const) {
              const g = gap(s, t);
              expect(g.clear, `${s.kind} already reaches ${t.kind}`).toBeGreaterThan(0);
              firstContact = Math.min(firstContact, g.contactS);
            }
          }
        }
        expect(firstContact).toBeLessThan(30);
        for (const b of [...own, ...enemy]) expect(Math.abs(b.x) + b.spread).toBeLessThan(SECTOR_PLAYABLE_HALF_EXTENT);
      });

      it('keeps the enemy closing: every enemy group gets a repeating aggro', () => {
        const steps = SceneScriptSchema.parse(o.sceneScript);
        const spawnTags = steps.flatMap((s) => (s.action === 'spawn' && s.hostile === true ? [s.tag] : []));
        const aggroTags = steps.flatMap((s) => (s.action === 'aggro' && s.repeatEveryMs !== undefined ? [s.tag] : []));
        expect(aggroTags.sort()).toEqual(spawnTags.sort());
      });
    });
  }

  it('onCreate keeps only its battle (client options dropped), clears the last run, and auto-disposes', async () => {
    const room = new BattleRoom() as unknown as { onCreate(o: unknown): Promise<void>; autoDispose: boolean };
    await room.onCreate({ battle: 'battle-subcaps', testMode: true, tickBurnMs: 50 });
    expect(created.at(-1)).toEqual(BATTLE_ROOMS['battle-subcaps']);
    expect(purged).toEqual(['old']);
    expect(room.autoDispose).toBe(true);
    await expect(room.onCreate({ battle: 'sandbox' })).rejects.toThrow(/unknown battle/);
    await expect(room.onCreate({})).rejects.toThrow(/unknown battle/);
  });

  it('defines one room per battle, passing only the battle id', () => {
    const define = vi.fn();
    defineBattleRooms({ define } as never);
    expect(define.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual(BATTLE_SECTOR_KEYS.map((k) => [k, BattleRoom, { battle: k }]));
  });
});
