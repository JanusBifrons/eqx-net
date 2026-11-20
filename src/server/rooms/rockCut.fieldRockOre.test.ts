/**
 * Field rock cut, slice 1C-c: the pieces of a cut-FIELD rock carry the
 * field's ore. The break copies the rock's ore rest frame (its rest centre,
 * `restX`/`restY` of its record) into the wreck's `WreckOre`; every re-split
 * hands that `ore` down whole; and `OreDraw.chunkYield` (the one ore path)
 * splits a chunk by the field's ore sampled there (`oreAtRest`), still its
 * share by weight of `rockOreTotal(rockMass)`. An ordinary rock's ore has
 * no rest frame and pays its `resource` as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { rockViewOf } from './rockCut.js';
import { OreDraw, chunkOreUnits } from './OreDraw.js';
import type { PieceStoreView } from './wreckLineage.js';
import { collectLineage, parseLineageRecord } from './wreckLineageRecord.js';
import { lineageRecordDeps } from './wreckLineageSaves.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { rocksInChunk } from '../../core/terrain/fieldLayout.js';
import { cutFieldOpts, fieldRockBody, fieldRockId } from '../../core/terrain/chunkStreamer.js';
import { asteroidShapeSeed } from '../../core/swarm/asteroidShape.js';

// OreDraw's hold store opens sqlite; chunkYield needs none of it.
vi.mock('../db/PersistenceWorker.js', () => ({ getHoldStore: () => null }));

const FIELD = cutFieldOpts('test-seed');
const ROCK = rocksInChunk(FIELD, 15, 0)[0]!; // in the field ring
const BODY = fieldRockBody(ROCK);
const FIELD_ID = fieldRockId(ROCK.key);
const PLAIN_ID = 'plain-rock';

function make(field: boolean) {
  const ID = field ? FIELD_ID : PLAIN_ID;
  let tick = 1000;
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>([ID]);
  const rec = (field
    ? { id: ID, kind: 0, radius: BODY.radius, fieldRock: true, fieldKey: ROCK.key, resources: 500, restX: BODY.x, restY: BODY.y }
    : { id: ID, kind: 0, radius: BODY.radius, shapeSeed: asteroidShapeSeed(ID), resources: 500 }) as unknown as SwarmEntityRecord;
  const reg = { get: (id: string) => (id === ID && live.has(ID) ? rec : null) };
  const pose = { x: BODY.x, y: BODY.y, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: () => null,
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? (spawned.get(id)?.angle ?? 0) : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePoseInto: (id, out) => { const s = spawned.get(id); if (s === undefined || !live.has(id)) return false; out.x = s.x; out.y = s.y; out.angle = s.angle; return true; },
    piecePose: (id) => {
      if (id === ID) return live.has(ID) ? pose : null;
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    dropSalvage: () => {},
    rockOf: (id) => rockViewOf(reg, id, FIELD),
    wakeFieldRock: () => {},
    fieldRockBroken: () => {},
  });
  sys.forcedSeed = 11;
  const hit = (id: string, x: number, y: number, r: number): void => {
    for (let n = 0; n < 400 && live.has(id); n++) { sys.onWreckHit(id, x + 2, y - r, 0, 1, 5_000, 'mining_laser'); tick++; }
  };
  const pieces = (): string[] => [...live].filter((id) => spawned.has(id));
  const view = (id: string): PieceStoreView => {
    const v: PieceStoreView = { mass: 0, radius: 0, qty: 0, ore: undefined, holdWeight: 0, rockMass: 0 };
    expect(sys.pieceStore(id, v)).toBe(true);
    return v;
  };
  hit(ID, BODY.x + 4, BODY.y, BODY.radius);
  return { sys, spawned, live, hit, pieces, view, ID };
}

/** A field stub: all ice wherever it is sampled, and the rest frame it was asked for. */
function iceDraw() {
  const asked: number[][] = [];
  const draw = new OreDraw({
    swarmRegistry: { get: () => null, getByEntityId: () => null },
    sectorKey: () => null,
    oreAtRest: (rx, ry, px, py, a, x, y, out) => { asked.push([rx, ry, px, py, a, x, y]); out.ice = 1; out.crystal = 0; return true; },
  });
  return { draw, asked };
}

describe('field rock ore (slice 1C-c)', () => {
  it("a field rock's piece gives the field's ore", () => {
    const r = make(true);
    expect(r.live.has(FIELD_ID), 'the field rock broke').toBe(false);
    const ids = r.pieces();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const v = r.view(ids[0]!);
    expect(v.ore).toMatchObject({ rockId: FIELD_ID, restX: BODY.x, restY: BODY.y });
    expect(v.qty, 'a piece worth taking').toBeGreaterThan(0);
    const { draw, asked } = iceDraw();
    const got = draw.chunkYield(v.ore!.rockId, 0, 0, v.mass, v.rockMass, v.ore!.resource, v.ore);
    expect(asked[0]!.slice(0, 2)).toEqual([BODY.x, BODY.y]);
    // The field's ore (all ice here), its share by weight of the whole rock's.
    expect(got.ice).toBe(chunkOreUnits(v.mass, v.rockMass));
    expect(got.minerals ?? 0).toBe(0);
    // No field in the room: the rock's own resource, as before.
    const plain = new OreDraw({ swarmRegistry: { get: () => null, getByEntityId: () => null }, sectorKey: () => null });
    expect(plain.chunkYield(v.ore!.rockId, 0, 0, v.mass, v.rockMass, v.ore!.resource, v.ore))
      .toEqual({ minerals: chunkOreUnits(v.mass, v.rockMass) });
  });

  it('a re-split field piece keeps its ore', () => {
    const r = make(true);
    const before = new Set(r.pieces());
    // Mine the heaviest piece until it splits.
    const big = [...before].sort((a, b) => r.view(b).mass - r.view(a).mass)[0]!;
    const s = r.spawned.get(big)!;
    r.hit(big, s.x, s.y, r.view(big).radius);
    expect(r.live.has(big), 'the piece re-split').toBe(false);
    const kids = r.pieces().filter((id) => !before.has(id));
    expect(kids.length).toBeGreaterThanOrEqual(2);
    for (const id of kids) {
      const v = r.view(id);
      expect(v.ore).toMatchObject({ rockId: FIELD_ID, restX: BODY.x, restY: BODY.y });
      expect(v.rockMass, 'shared by weight of the whole rock').toBe(r.view([...before].find((p) => r.live.has(p))!).rockMass);
    }
    // ... and it rides the lineage save.
    const rec = parseLineageRecord(JSON.parse(JSON.stringify(collectLineage(r.sys.lineageRootOf(kids[0]!)!, lineageRecordDeps(r.sys.lineageState())))));
    const ores = rec!.nodes.map((n) => n.ore).filter((o) => o !== undefined);
    expect(ores.length).toBeGreaterThanOrEqual(2);
    for (const o of ores) expect(o).toMatchObject({ restX: BODY.x, restY: BODY.y });
  });

  it("an ordinary rock's ore has no rest frame and pays its resource", () => {
    const r = make(false);
    const v = r.view(r.pieces()[0]!);
    expect(v.ore).toBeDefined();
    expect(v.ore).not.toHaveProperty('restX');
    expect(v.ore).not.toHaveProperty('restY');
    const { draw, asked } = iceDraw();
    expect(draw.chunkYield(v.ore!.rockId, 0, 0, v.mass, v.rockMass, v.ore!.resource, v.ore))
      .toEqual({ minerals: chunkOreUnits(v.mass, v.rockMass) });
    expect(asked).toEqual([]);
  });
});
