/**
 * Wreck fields slice 5 (docs/architecture/macro-terrain.md "F3"): a client
 * that joins AFTER an old battlefield's hulls loaded, one of its pieces was
 * moved, and its chunk unloaded into a lineage row and reloaded from it,
 * still sees exactly the server's live wrecks (#16: client state is
 * reconstructible from snapshot ∪ welcome). Field hulls are ordinary live
 * wrecks, so they ride the existing `wrecks[]` welcome, the snapshot
 * add/remove deltas and the rolling resync; there is no field-specific wire.
 *
 * The joiner listens to the welcome, snapshots and the binary swarm wire
 * only (no discrete events). Its descriptors must equal the server's live
 * set, and every server piece inside its interest window must arrive as a
 * kind-4 record that rebuilds to the server's exact convex parts, at the
 * server's pose.
 *
 * Prints (never asserts) the welcome's wreck bytes and the resync cycle time
 * for the worst-case ring (layout seed `a`: 56 pieces, `FIELD_RING_WORST_PIECES`)
 * with one ship parked at its densest point. Read them from the
 * `[wreck-field late joiner]` lines in the test output.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Packr } from '@colyseus/msgpackr';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { CELL_SIZE } from '../../../src/server/interest/SpatialGrid.js';
import { FIELD_CAP_SHIPS, FIELD_LIVE_CAP, FIELD_RING_WORST_PIECES } from '../../../src/server/rooms/wreckFifos.js';
import { WRECK_RESYNC_CHUNK, WRECK_RESYNC_EVERY } from '../../../src/server/rooms/WreckWireDeltas.js';
import { wreckField, hullsInChunk, wreckFieldHullFracture, WRECK_FIELD, type WreckFieldHull } from '../../../src/core/terrain/wreckFieldLayout.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { CHUNK_SIZE } from '../../../src/core/terrain/fieldLayout.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { decodeSwarmPacket } from '../../../src/client/net/BinarySwarmDecoder.js';
import { WreckGeometryStore } from '../../../src/client/net/wreckGeometryStore.js';
import type { RenderMirror } from '../../../src/core/contracts/IRenderer.js';
import type { SnapshotMessage, WreckDescriptor } from '../../../src/shared-types/messages/snapshotMessages.js';

const WRECK_KIND = 4;
/** The wreck fields of a swarm record (the internals type lists only the common ones). */
type WreckRec = { id: string; kind: number; entityId: number; wreckId?: number; componentIndex?: number; wreckParts?: unknown };
const SPEED = 4;
/** Room updates (= broadcast counters) per GAME second (SectorRoom tick loop). */
const UPDATES_PER_GAME_S = 60;
/** Seed `a` is the layout's worst 5 x 5 ring (wreckFieldLayout.test.ts: 56 pieces). */
const OPTS = { seed: 'a', x: 0, y: 0, sides: ['ashen-league', 'vel-concord'] as const };
const FIELD = wreckField(OPTS);
const RING = 2; // the streamer's wake ring (5×5 chunks)

/** Hulls (and their pieces) in the 5×5 ring around chunk (cx, cy). */
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

/** The densest ring, and a spawn point in its centre chunk clear of every hull
 *  (same search as wreckFieldStreaming.test.ts). */
function densest(): { x: number; y: number; hulls: WreckFieldHull[]; pieces: number } {
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
      if (clear) return { hulls: best.hulls, pieces: best.pieces, x, y };
    }
  }
  throw new Error('no clear spawn point in the densest chunk');
}

/** A descriptor without its absent (undefined / nil) fields, for comparing
 *  what the client decoded against the server's object. */
function norm(d: WreckDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

describe('SectorRoom integration — late joiner sees the wreck field (wreck fields 5)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { await harness?.cleanup(); harness = undefined; }, 10_000);

  type Internals = SectorRoom['_internals'];
  const spot = densest();

  async function until(what: string | (() => string), ok: () => boolean, gameS = 20): Promise<void> {
    const deadline = Date.now() + (gameS / SPEED) * 1000 + 5000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${typeof what === 'string' ? what : what()}`);
      await harness!.advance(100);
    }
  }

  it('a joiner after load, a moved piece and an unload/reload converges from welcome + snapshots alone; prints welcome bytes and resync cycle', { timeout: 90_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, testMode: true, droneCount: 0, peacefulDrones: true, asteroidConfig: [],
      timeScale: SPEED, capitalWrecks: true, subcapWrecks: true, wreckField: OPTS,
    });
    const playerId = randomUUID();
    await harness.connectActive(playerId, { shipKind: 'fighter', spawnX: spot.x, spawnY: spot.y });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): Internals => room._internals;
    const wreckRecs = (): Iterable<WreckRec> => int().swarmRegistry.all() as unknown as Iterable<WreckRec>;
    const src = int().wreckFieldSource!;
    const fieldPieces = (): number => src.livePieces();
    const want = Math.min(spot.pieces, FIELD_LIVE_CAP);
    expect(spot.pieces, 'seed a is the measured worst ring').toBe(FIELD_RING_WORST_PIECES);
    await until('ring loaded', () => fieldPieces() >= want);

    /** The live field piece nearest (x, y): the one the joiner will have in interest. */
    const nearestPiece = (x: number, y: number): { id: string; x: number; y: number; angle: number } => {
      let best: { id: string; x: number; y: number; angle: number } | null = null;
      let bestD = Infinity;
      for (const id of src.pieceIds()) {
        const s = int().wreckState(id);
        if (s === null) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bestD) { bestD = d; best = { id, x: s.x, y: s.y, angle: s.angle }; }
      }
      return best!;
    };
    const shove = (p: { id: string; x: number; y: number; angle: number }, dx: number, dy: number): { x: number; y: number } => {
      const to = { x: p.x + dx, y: p.y + dy };
      int().postToWorker({ type: 'SET_POSITION', entityId: p.id, x: to.x, y: to.y, angle: p.angle, vx: 0, vy: 0, angvel: 0 });
      return to;
    };

    // 1. Move a piece (touches its hull).
    const first = shove(nearestPiece(spot.x, spot.y), 60, -25);
    await harness.advance(300);

    // 2. Leave past the linger: the touched hull unloads into its lineage row,
    //    the rest retire. Come back: the touched hull reloads from the row.
    const away = { x: spot.x + 12 * CHUNK_SIZE, y: spot.y };
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: away.x, y: away.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until(() => `touched hull unloaded: ${JSON.stringify(src.stats)}`, () => src.stats.hullsUnloaded === 1 && src.stats.hullsRetired === spot.hulls.length - 1, 30);
    expect(int().wreckDescriptors().length).toBe(0);
    int().postToWorker({ type: 'SET_POSITION', entityId: playerId, x: spot.x, y: spot.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await until(() => `ring reloaded: ${JSON.stringify(src.stats)}`, () => fieldPieces() >= want);
    await harness.advance(300);
    expect(src.stats.hullsRestored).toBe(1);

    // 3. Move the restored piece again, so the live pose matches neither the seed nor the row.
    const restored = nearestPiece(first.x, first.y);
    expect(Math.hypot(restored.x - first.x, restored.y - first.y), 'the restored piece sits where it was left').toBeLessThan(0.5);
    const moved = shove(restored, -40, 30);
    await harness.advance(500);

    // 4. The late joiner, beside the first ship.
    const liveAtJoin = int().wreckDescriptors().length;
    expect(liveAtJoin).toBe(src.stats.hullsLive);
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    const store = new WreckGeometryStore();
    const packr = new Packr({ encodeUndefinedAsNil: false });
    let gotWrecks: WreckDescriptor[] | undefined;
    let welcomeBytes = 0;
    let fullListOnSnapshot = false;
    /** Resync chunks seen per full walk of the id space (lo = 1 starts a walk). */
    const walks: number[] = [];
    let chunksThisWalk = -1;
    const joinerId = randomUUID();
    const late = await harness.connectAs(joinerId, { shipKind: 'fighter', spawnX: spot.x, spawnY: spot.y + 150 });
    late.onMessage('welcome', (msg: { wrecks?: WreckDescriptor[] }) => {
      welcomeBytes = packr.pack(msg).byteLength;
      if (msg.wrecks !== undefined) {
        gotWrecks = msg.wrecks;
        store.apply(msg.wrecks);
      }
    });
    late.onMessage('swarm', (buf: Uint8Array) => decodeSwarmPacket(buf, mirror));
    late.onMessage('snapshot', (snap: SnapshotMessage) => {
      if ((snap as { wrecks?: unknown }).wrecks !== undefined) fullListOnSnapshot = true;
      if (snap.wreckSync !== undefined) {
        if (snap.wreckSync.lo === 1) {
          if (chunksThisWalk > 0) walks.push(chunksThisWalk);
          chunksThisWalk = 0;
        }
        if (chunksThisWalk >= 0) chunksThisWalk++;
      }
      store.applySnapshot(snap);
    });
    late.send('client_ready', { type: 'client_ready' });

    /** Server field pieces surely inside the joiner's 3×3 interest window. */
    const inWindow = (): { id: string; entityId: number; wreckId: number; componentIndex: number; x: number; y: number }[] => {
      const me = int().playerPose(joinerId);
      if (me === null) return [];
      const out: { id: string; entityId: number; wreckId: number; componentIndex: number; x: number; y: number }[] = [];
      for (const r of wreckRecs()) {
        if (r.kind !== WRECK_KIND) continue;
        const s = int().wreckState(r.id);
        if (s === null || Math.abs(s.x - me.x) >= CELL_SIZE || Math.abs(s.y - me.y) >= CELL_SIZE) continue;
        out.push({ id: r.id, entityId: r.entityId, wreckId: r.wreckId!, componentIndex: r.componentIndex!, x: s.x, y: s.y });
      }
      return out;
    };
    const converged = (): boolean => {
      if (gotWrecks === undefined || walks.length === 0) return false;
      const server = int().wreckDescriptors();
      if (store.descriptors.size !== server.length) return false;
      for (const d of server) if (!store.has(d.wreckId)) return false;
      const win = inWindow();
      if (win.length === 0) return false;
      for (const p of win) if (mirror.swarm?.get(p.entityId)?.kind !== WRECK_KIND) return false;
      return true;
    };
    await until('the joiner converged and saw one full resync walk', converged, 20);

    // Counts: the welcome carried every live descriptor; snapshots never the full list.
    expect(gotWrecks, 'the late joiner got the full wreck set in its welcome').toBeDefined();
    expect(gotWrecks!.length, 'welcome descriptors == live descriptors at join').toBe(liveAtJoin);
    expect(fullListOnSnapshot, 'snapshots never carry the full list').toBe(false);

    // Descriptors: exactly the server's live set, field for field.
    const server = int().wreckDescriptors();
    expect([...store.descriptors.keys()].sort((a, b) => a - b)).toEqual(server.map((d) => d.wreckId).sort((a, b) => a - b));
    for (const d of server) expect(norm(store.descriptors.get(d.wreckId)!), `descriptor ${d.wreckId}`).toEqual(norm(d));

    // Pieces: every server piece in the window arrived, rebuilt to the exact parts, at the server pose.
    const window = inWindow();
    expect(window.length, 'the joiner has field pieces in interest').toBeGreaterThan(0);
    expect(window.some((p) => Math.hypot(p.x - moved.x, p.y - moved.y) < 0.5), 'the twice-moved piece is in the joiner\'s window').toBe(true);
    for (const p of window) {
      const e = mirror.swarm!.get(p.entityId)!;
      expect(e.kind).toBe(WRECK_KIND);
      expect(e.wreckId).toBe(p.wreckId);
      expect(e.componentIndex).toBe(p.componentIndex);
      const g = store.piece(e.wreckId!, e.componentIndex!);
      expect(g, `piece ${p.id} rebuilt on the client`).not.toBeNull();
      const r = int().swarmRegistry.get(p.id) as unknown as WreckRec;
      expect(g!.parts).toStrictEqual(r.wreckParts);
      expect(Math.hypot(e.x - p.x, e.y - p.y), `piece ${p.id} at the server pose`).toBeLessThan(4);
    }
    // No ghosts: every kind-4 record the joiner holds is a live server piece of the same wreck.
    const byEntity = new Map<number, { wreckId?: number }>();
    for (const r of wreckRecs()) if (r.kind === WRECK_KIND) byEntity.set(r.entityId, r);
    for (const [eid, e] of mirror.swarm ?? []) {
      if (e.kind !== WRECK_KIND) continue;
      expect(byEntity.get(eid)?.wreckId, `client piece ${eid} is live on the server`).toBe(e.wreckId);
    }

    // Timings (printed, not asserted). The resync walk sends WRECK_RESYNC_CHUNK
    // descriptors per chunk, one chunk per recipient every WRECK_RESYNC_EVERY
    // broadcast counters (60 per game second).
    const period = WRECK_RESYNC_EVERY / UPDATES_PER_GAME_S;
    const chunks = Math.max(1, Math.ceil(server.length / WRECK_RESYNC_CHUNK));
    const wreckBytes = packr.pack(gotWrecks).byteLength;
    const perDesc = wreckBytes / Math.max(1, gotWrecks!.length);
    console.log(`[wreck-field late joiner] worst ring (seed a): ${spot.hulls.length} hulls, ${fieldPieces()} live pieces, ${server.length} live descriptors`);
    console.log(`[wreck-field late joiner] welcome: wrecks[] ${wreckBytes} B (${perDesc.toFixed(1)} B/descriptor, msgpack), whole welcome ${welcomeBytes} B`);
    console.log(`[wreck-field late joiner] resync cycle: ${server.length} descriptors / ${WRECK_RESYNC_CHUNK} per chunk = ${chunks} chunks x ${period.toFixed(2)} s = ${(chunks * period).toFixed(2)} game s (observed chunks per walk: ${walks.join(', ')})`);
    const allRings = server.length * FIELD_CAP_SHIPS;
    const allChunks = Math.ceil(allRings / WRECK_RESYNC_CHUNK);
    console.log(`[wreck-field late joiner] scaled (arithmetic, not measured): ${FIELD_CAP_SHIPS} ships in separate worst rings = ${allRings} descriptors, welcome ~${Math.round(allRings * perDesc)} B, resync cycle ${allChunks} chunks = ${(allChunks * period).toFixed(1)} game s`);
  });
});
