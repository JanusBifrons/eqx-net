/**
 * Battle scenario rooms (`?room=battle-*`, docs/features/battle-scenarios.md):
 * two fleets, no bases, no turrets, no rocks, that START APART and fly in to
 * fight, so a pilot (or a commander, `startMode=command`) feels a battle open
 * up instead of spawning inside one.
 *
 * Built on the scene script (no new system): the pilot's side is a `fleet`
 * step (PARKED hulls the pilot owns, AI-flown, `hunt` + `aggressive`); the
 * enemy side is `spawn` steps marked hostile, kept closing by a repeating
 * `aggro` step (a hostile mark is forgotten after ~30 s without a hit).
 *
 * Each room is a SEALED sector (sealedSectors.ts: never saved, nothing
 * leaves, its roster rows never reach the real hangar), so it is safe on the
 * phone lane, which registers it with the sandbox (not testMode). Like the
 * sandbox, client create options never reach the room: `BattleRoom.onCreate`
 * keeps only the battle id its `define` gave it. Unlike the sandbox it is
 * thrown away when the last pilot leaves (`autoDispose`), and a new one first
 * clears the last run's roster rows, so every visit is a fresh battle.
 *
 * Layout: the pilot's line at x = -D/2, the enemy's at x = +D/2, both lines
 * running north-south with every hull nose north (spawned ships face +y), so
 * the fleets start side-on to each other. D is a little past the longest gun
 * on the field: the first shots come as the lines close.
 */
import type { Server } from 'colyseus';
import { SectorRoom } from '../SectorRoom.js';
import { BATTLE_SECTOR_KEYS, isSealedSectorKey, type BattleSectorKey } from '../sealedSectors.js';
import { purgeSealedRosterRows } from '../rosterSealing.js';
import { getHoldStore, getPlayerShipStore } from '../../db/PersistenceWorker.js';
import { getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import type { SectorRoomOptions } from '../sectorRoomOptions.js';

/** Gap between neighbouring capitals in a line (hull edge to hull edge). */
const CAPITAL_GAP = 1500;
/** Re-mark the enemy hostile this often, for the whole 10-minute script. */
const AGGRO_EVERY_MS = 20_000;
const AGGRO_UNTIL_MS = 600_000;

type Step = Record<string, unknown>;

/** One group in a line: `count` of `kind`, spread in a disc (sub-caps) or
 *  one capital per slot (count 1, spread 0). `dx` pushes the group toward
 *  (+) or away from (-) the enemy. */
interface Group { kind: ShipKindId; count: number; spread?: number; dx?: number }

/** Y centres for a north-south line of `sizes` (radii), the pilot's slot
 *  (`hole` radius, 0 = none) in the middle, centred on y = 0. */
function lineYs(sizes: readonly number[], hole: number): { ys: number[]; holeY: number } {
  const half = Math.ceil(sizes.length / 2);
  const all = hole > 0 ? [...sizes.slice(0, half), hole, ...sizes.slice(half)] : [...sizes];
  const ys: number[] = [];
  let y = 0;
  for (let i = 0; i < all.length; i++) {
    if (i > 0) y += all[i - 1]! + CAPITAL_GAP + all[i]!;
    ys.push(y);
  }
  const mid = hole > 0 ? ys[half]! : (ys[0]! + ys[ys.length - 1]!) / 2;
  const centred = ys.map((v) => Math.round(v - mid));
  const holeY = hole > 0 ? centred.splice(half, 1)[0]! : 0;
  return { ys: centred, holeY };
}

function groupSize(g: Group): number {
  return g.count > 1 ? (g.spread ?? 0) + getShipKind(g.kind).radius : getShipKind(g.kind).radius;
}

/** The pilot's side: `fleet` steps at x = -d/2 (the pilot's slot is the
 *  hole, `holeR` wide, at the centre of the line). */
function ownSide(d: number, groups: readonly Group[], holeR: number): { steps: Step[]; spawnY: number } {
  const { ys, holeY } = lineYs(groups.map(groupSize), holeR);
  const x = -d / 2;
  const steps = groups.map((g, i) => ({
    atMs: 0, action: 'fleet', tag: 'own', kind: g.kind, count: g.count,
    x: x + (g.dx ?? 0), y: ys[i]!, ...(g.spread !== undefined ? { spread: g.spread } : {}),
    mode: 'hunt', stance: 'aggressive',
  }));
  return { steps, spawnY: holeY };
}

/** The enemy: one hostile `spawn` per group at x = +d/2 (tag `e<i>`), each
 *  with its repeating `aggro`. */
function enemySide(d: number, groups: readonly Group[]): Step[] {
  const { ys } = lineYs(groups.map(groupSize), 0);
  const x = d / 2;
  const steps: Step[] = [];
  groups.forEach((g, i) => {
    const tag = `e${i}`;
    steps.push({
      atMs: 0, action: 'spawn', tag, kind: g.kind, count: g.count,
      x: x - (g.dx ?? 0), y: ys[i]!, ...(g.spread !== undefined ? { spread: g.spread } : {}), hostile: true,
    });
    steps.push({ atMs: AGGRO_EVERY_MS, action: 'aggro', tag, count: g.count, repeatEveryMs: AGGRO_EVERY_MS, repeatUntilMs: AGGRO_UNTIL_MS });
  });
  return steps;
}

/** Room options for one battle: a sealed, empty, unsaved sector. */
function battleOpts(key: BattleSectorKey, d: number, own: readonly Group[], enemy: readonly Group[]): SectorRoomOptions {
  const mine = ownSide(d, own, getShipKind(BATTLE_PILOT_KIND[key]).radius);
  return {
    sectorKey: key,
    sealed: true,
    persistSector: false,
    asteroidConfig: [],
    droneCount: 0,
    sceneScript: [...mine.steps, ...enemySide(d, enemy)],
    defaultSpawnX: -d / 2,
    defaultSpawnY: mine.spawnY,
  };
}

const cap = (kind: ShipKindId): Group => ({ kind, count: 1 });
const wing = (kind: ShipKindId, count: number, spread: number, dx = 0): Group => ({ kind, count, spread, dx });

/** The hull to join each battle in (`?shipKind=`): the slot left in your line. */
export const BATTLE_PILOT_KIND: Readonly<Record<BattleSectorKey, ShipKindId>> = {
  'battle-capitals': 'battleship',
  'battle-caps-vs-subcaps': 'battleship',
  'battle-subcaps-vs-caps': 'fighter',
  'battle-subcaps': 'fighter',
  'battle-mixed': 'battleship',
};

/** Every battle room, by sector key (= room name). Distances: the battleship's
 *  guns reach ~38.7 km, a destroyer's ~16.6 km, a sub-cap's ~1.4-1.8 km. */
export const BATTLE_ROOMS: Readonly<Record<BattleSectorKey, SectorRoomOptions>> = {
  // Capital fleet vs capital fleet. Join as a battleship (the gap in the line).
  'battle-capitals': battleOpts('battle-capitals', 42_000,
    [cap('battlecruiser'), cap('heavy-cruiser'), cap('light-cruiser'), cap('destroyer'), cap('destroyer')],
    [cap('battleship'), cap('battlecruiser'), cap('heavy-cruiser'), cap('light-cruiser'), cap('destroyer'), cap('destroyer')]),
  // Your capitals vs an enemy sub-cap swarm that has to cross the big guns' reach.
  'battle-caps-vs-subcaps': battleOpts('battle-caps-vs-subcaps', 40_000,
    [cap('heavy-cruiser'), cap('light-cruiser'), cap('destroyer'), cap('destroyer')],
    [wing('fighter', 16, 900), wing('heavy', 8, 700), wing('gunship', 6, 600), wing('missile-frigate', 4, 500)]),
  // Your sub-cap wing vs enemy capitals: fly in under their guns. Join as a fighter.
  'battle-subcaps-vs-caps': battleOpts('battle-subcaps-vs-caps', 40_000,
    [wing('fighter', 7, 500), wing('heavy', 4, 400), wing('gunship', 4, 400), wing('missile-frigate', 2, 300)],
    [cap('battleship'), cap('heavy-cruiser'), cap('light-cruiser'), cap('destroyer'), cap('destroyer')]),
  // A load of sub-caps a side. Join as a fighter.
  'battle-subcaps': battleOpts('battle-subcaps', 8000,
    [wing('fighter', 6, 450), wing('heavy', 3, 350), wing('gunship', 2, 300), wing('missile-frigate', 2, 300)],
    [wing('fighter', 8, 500), wing('interceptor', 2, 250), wing('heavy', 4, 400), wing('gunship', 3, 350), wing('missile-frigate', 2, 300)]),
  // Both sides capitals AND sub-caps; the sub-cap wings ride ahead of their line.
  'battle-mixed': battleOpts('battle-mixed', 46_000,
    [cap('heavy-cruiser'), cap('destroyer'), wing('fighter', 6, 500, 4000), wing('heavy', 3, 400, 4000), wing('gunship', 2, 300, 4000)],
    [cap('battleship'), cap('heavy-cruiser'), cap('destroyer'), wing('fighter', 7, 500, 4000), wing('heavy', 3, 400, 4000), wing('gunship', 2, 300, 4000), wing('missile-frigate', 2, 300, 4000)]),
};

/** A sealed sector that keeps only its battle's own options (see header). */
export class BattleRoom extends SectorRoom {
  override async onCreate(options: unknown): Promise<void> {
    // `battle` comes from the `define` options, which win over a client's.
    const key = (options as { battle?: unknown } | null)?.battle;
    const opts = typeof key === 'string' ? (BATTLE_ROOMS as Record<string, SectorRoomOptions>)[key] : undefined;
    if (opts === undefined || !isSealedSectorKey(key as string)) throw new Error(`battle room: unknown battle ${String(key)}`);
    // The last run's hulls (the pilot's and the scripted fleet's) go first.
    purgeSealedRosterRows(getPlayerShipStore(), getHoldStore(), key as string);
    await super.onCreate({ ...opts });
    // A sectorKey room is permanent by default; a battle is thrown away.
    this.autoDispose = true;
    this.maxClients = 4;
  }
}

/** Register every battle room (gated with the sandbox: `shouldRegisterSandboxRoom`). */
export function defineBattleRooms(gameServer: Pick<Server, 'define'>): void {
  for (const key of BATTLE_SECTOR_KEYS) gameServer.define(key, BattleRoom, { battle: key });
}
