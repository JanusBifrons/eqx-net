/**
 * Wreck fields slice 3b (docs/architecture/macro-terrain.md "F3"): a room
 * with the `wreckField` option streams an old battlefield's hulls in by
 * chunk through the ONE streamer. A pilot entering the field loads the hulls
 * around it, asleep and still, as many pieces as the layout says; leaving
 * and coming back never double-spawns; untouched hulls retire after the
 * linger; and a battle break-up beside the field evicts nothing of it (nor
 * the field anything of the battle). Counts only; prints the live field
 * pieces with one ship in the densest ring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { wreckField, hullsInChunk, wreckFieldHullFracture, WRECK_FIELD, type WreckFieldHull } from '../../../src/core/terrain/wreckFieldLayout.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { CHUNK_SIZE } from '../../../src/core/terrain/fieldLayout.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { FIELD_LIVE_CAP } from '../../../src/server/rooms/wreckFifos.js';

const WRECK_KIND = 4;
const SPEED = 4;
const OPTS = { seed: 'it', x: 0, y: 0, sides: ['ashen-league', 'vel-concord'] as const };
const FIELD = wreckField(OPTS);
const RING = 2; // the streamer's wake ring (5×5 chunks)

/** Hulls (and their estimated pieces) in the 5×5 ring around chunk (cx, cy). */
function ring(cx: number, cy: number): { hulls: WreckFieldHull[]; pieces: number } {
  const hulls: WreckFieldHull[] = [];
  let pieces = 0;
  for (let dx = -RING; dx <= RING; dx++) {
    for (let dy = -RING; dy <= RING; dy++) {
      for (const h of hullsInChunk(FIELD, cx + dx, cy + dy)) { hulls.push(h); pieces += wreckPieceGeometry(wreckFieldHullFracture(h)).length; }
    }
  }
  return { hulls, pieces };
}

/** The densest ring, and a spawn point in its centre chunk clear of every hull. */
function densest(): { cx: number; cy: number; x: number; y: number; hulls: WreckFieldHull[]; pieces: number } {
  let best = { cx: 0, cy: 0, hulls: [] as WreckFieldHull[], pieces: -1 };
  const seen = new Set<string>();
  for (const h of FIELD.hulls) {
    if (seen.has(`${h.cx},${h.cy}`)) continue;
    seen.add(`${h.cx},${h.cy}`);
    const r = ring(h.cx, h.cy);
    if (r.pieces > best.pieces) best = { cx: h.cx, cy: h.cy, ...r };
  }
  for (let i = 1; i < 8; i++) {
    for (let j = 1; j < 8; j++) {
      const x = (best.cx + i / 8) * CHUNK_SIZE, y = (best.cy + j / 8) * CHUNK_SIZE;
      const clear = FIELD.hulls.every((h) => Math.hypot(h.x - x, h.y - y) > getShipKind(h.kindId).radius * WRECK_FIELD.footprintMul + 600);
      if (clear) return { ...best, x, y };
    }
  }
  throw new Error('no clear spawn point in the densest chunk');
}

describe('SectorRoom integration — wreck field streaming (wreck fields 3b)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { await harness?.cleanup(); harness = undefined; }, 10_000);

  type Internals = SectorRoom['_internals'];
  const spot = densest();

  async function boot(): Promise<{ int: () => Internals; playerId: string }> {
    harness = await bootSectorTestServer({
      sectorKey: null, testMode: true, droneCount: 0, peacefulDrones: true, asteroidConfig: [],
      timeScale: SPEED, capitalWrecks: true, subcapWrecks: true, wreckField: OPTS,
    });
    const playerId = randomUUID();
    await harness.connectActive(playerId, { shipKind: 'fighter', spawnX: spot.x, spawnY: spot.y });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    return { int: () => room._internals, playerId };
  }

  async function until(what: string | (() => string), ok: () => boolean, gameS = 20): Promise<void> {
    const deadline = Date.now() + (gameS / SPEED) * 1000 + 5000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${typeof what === "string" ? what : what()}`);
      await harness!.advance(100);
    }
  }

  const fieldPieces = (int: Internals) => int.wreckFieldSource!.livePieces();
  const wreckPieces = (int: Internals) => { let n = 0; for (const r of int.swarmRegistry.all()) if (r.kind === WRECK_KIND) n++; return n; };

  it('entering loads the ring\'s hulls asleep and still, as many pieces as the layout says; re-entry never double-spawns; untouched hulls retire', { timeout: 60_000 }, async () => {
    const { int, playerId } = await boot();
    const src = int().wreckFieldSource!;
    expect(spot.hulls.length).toBeGreaterThan(0);
    const want = Math.min(spot.pieces, FIELD_LIVE_CAP);
    await until('ring loaded', () => fieldPieces(int()) >= want);
    console.log(`[wreck-field] densest ring: ${spot.hulls.length} hulls, ${spot.pieces} pieces (layout); live field pieces with one ship there: ${fieldPieces(int())} (cap ${FIELD_LIVE_CAP})`);
    expect(fieldPieces(int())).toBe(want);
    expect(wreckPieces(int())).toBe(want);
    expect(src.stats.hullsLive).toBe(spot.hulls.length);

    // Asleep from the start, and still.
    await harness!.advance(200);
    const ids = src.pieceIds();
    const rest = new Map(ids.map((id) => [id, { ...int().wreckState(id)! }]));
    for (const id of ids) expect(int().swarmSleeping(id), `${id} awake`).toBe(true);
    await harness!.advance(1000);
    for (const id of ids) {
      const p = int().wreckState(id)!, r = rest.get(id)!;
      expect(Math.hypot(p.x - r.x, p.y - r.y), `${id} moved`).toBeLessThan(1e-3);
    }

    // Leave (well past the ring) and come straight back: nothing new spawns.
    const away = { x: spot.x + 12 * CHUNK_SIZE, y: spot.y };
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: away.x, y: away.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await harness!.advance(500);
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: spot.x, y: spot.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await harness!.advance(1000);
    expect(src.stats.hullsSpawned).toBe(spot.hulls.length);
    expect(fieldPieces(int())).toBe(want);

    // Leave for longer than the linger: the untouched hulls retire.
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: away.x, y: away.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until(() => `untouched hulls retired: ${JSON.stringify(src.stats)}, ship ${JSON.stringify(int().playerPose(playerId) ?? null)}`, () => src.stats.hullsRetired === spot.hulls.length, 20);
    expect(fieldPieces(int())).toBe(0);
    expect(wreckPieces(int())).toBe(0);

    // Back again: the same hulls, once each.
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: spot.x, y: spot.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until('ring reloaded', () => fieldPieces(int()) >= want);
    expect(fieldPieces(int())).toBe(want);
    expect(src.stats.hullsLive).toBe(spot.hulls.length);
  });

  it('slice 4: a touched hull unloads into a lineage row when nothing is near, and reloads from it where it was left', { timeout: 60_000 }, async () => {
    const { int, playerId } = await boot();
    const src = int().wreckFieldSource!;
    const want = Math.min(spot.pieces, FIELD_LIVE_CAP);
    await until('ring loaded', () => fieldPieces(int()) >= want);
    // Touch one hull: shove one of its pieces 60 u.
    const id = src.pieceIds()[0]!;
    const p = { ...int().wreckState(id)! };
    const moved = { x: p.x + 60, y: p.y - 25 };
    int().postToWorker({ type: 'SET_POSITION', entityId: id, x: moved.x, y: moved.y, angle: p.angle, vx: 0, vy: 0, angvel: 0 });
    await harness!.advance(300);

    // Leave for longer than the linger: untouched hulls retire, the touched one unloads into its row.
    const away = { x: spot.x + 12 * CHUNK_SIZE, y: spot.y };
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: away.x, y: away.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until(() => `touched hull unloaded: ${JSON.stringify(src.stats)}`, () => src.stats.hullsUnloaded === 1 && src.stats.hullsRetired === spot.hulls.length - 1, 30);
    expect(fieldPieces(int())).toBe(0);
    expect(wreckPieces(int())).toBe(0);
    expect(int().wreckDescriptors().length).toBe(0);

    // Back: the touched hull comes from its row (at the moved pose), the rest from the seed, once each.
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: spot.x, y: spot.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until(() => `ring reloaded: ${JSON.stringify(src.stats)}`, () => fieldPieces(int()) >= want);
    await harness!.advance(300);
    expect(src.stats.hullsRestored).toBe(1);
    expect(fieldPieces(int())).toBe(want);
    expect(src.stats.hullsLive).toBe(spot.hulls.length);
    const near = src.pieceIds().some((q) => { const s = int().wreckState(q); return s !== null && Math.hypot(s.x - moved.x, s.y - moved.y) < 0.5; });
    expect(near, 'a reloaded piece sits where the moved one was left').toBe(true);
  });

  it('a battle break-up beside the field evicts none of it, and the field none of the battle', { timeout: 60_000 }, async () => {
    const { int } = await boot();
    const want = Math.min(spot.pieces, FIELD_LIVE_CAP);
    await until('ring loaded', () => fieldPieces(int()) >= want);
    expect(int().spawnTestDrone('f1', spot.x + 800, spot.y, 'fighter')).toBe(true);
    await harness!.advance(100);
    const at = int().wreckState('f1')!;
    int().applyDamage('f1', 'shooter-x', 1e7, at.x + 20, at.y);
    await harness!.advance(200);
    const battle = wreckPieces(int()) - fieldPieces(int());
    expect(battle).toBeGreaterThanOrEqual(2);
    expect(fieldPieces(int())).toBe(want);
    await harness!.advance(1000);
    expect(wreckPieces(int()) - fieldPieces(int())).toBe(battle);
    expect(fieldPieces(int())).toBe(want);
  });
});
