/**
 * Macro terrain C5f / C5g: a generated NPC base seeded at room create
 * (`SectorRoom.onCreate` → `seedNpcBases`) in a cut-field room. The cut-field
 * subsystem is built before the seeding, so every slot the generator lays on
 * a dormant field rock is refused, and no power link of the base runs through
 * a field rock. The base sits where the field is dense: its Capital in a
 * clear spot of chunks (-9..-7, 5..7) of seed 'look' whose grown layout overlaps rocks
 * and has generated links whose line crosses one.
 *
 * Links are socket-to-socket curved cables (structure restyle 0d), so the
 * placed base's links are checked along each stored link's real cable
 * (`flattenLinkCable`), not the centre line.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { NpcBaseSubsystem, type NpcBaseSpec } from '../../../src/server/bases/NpcBaseSubsystem.js';
import { cutFieldOpts, fieldRockBody, fieldRocksInBox } from '../../../src/core/terrain/chunkStreamer.js';
import { CHUNK_SIZE } from '../../../src/core/terrain/fieldLayout.js';
import { structureHalfExtents } from '../../../src/shared-types/structureKinds.js';
import { clampToSectorBounds } from '../../../src/shared-types/sectorBounds.js';
import { placementRejection } from '../../../src/core/structures/placementRules.js';
import { rockObstacleParts, segmentHitsObstacle, type GridObstacle } from '../../../src/core/structures/Grid.js';
import { CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, flattenLinkCable, makeCableBox } from '../../../src/core/structures/cableCurve.js';
import { structureToGridNode } from '../../../src/server/structures/structureGridView.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — an NPC base seeded in the cut field (C5f/C5g)', () => {
  it('no base structure sits on a field rock and no base link crosses one', { timeout: 90_000 }, async () => {
    const o = cutFieldOpts('look');
    const shaped = (x0: number, y0: number, x1: number, y1: number): GridObstacle[] =>
      fieldRocksInBox(o, x0, y0, x1, y1).map((n) => { const b = fieldRockBody(n); return { x: n.x, y: n.y, radius: n.radius, angle: 0, parts: rockObstacleParts(b.verts, b.parts, true) }; });
    const onRock = (kind: string, x: number, y: number, rot: number, rocks: readonly GridObstacle[]): boolean =>
      placementRejection(kind, x, y, [], rocks, rot) !== null;

    // The grown layout (pure: the generator, nothing placed).
    const base: Omit<NpcBaseSpec, 'x' | 'y'> = { baseId: 'f1', role: 'refinery', tier: 'settlement', seed: 12, features: ['minerals'] };
    const grower = new NpcBaseSubsystem({ registry: null as never, place: () => null, setHealth: () => {} });
    const grown = grower.grow({ ...base, x: 0, y: 0 });
    let ex = 0;
    for (const p of grown.placements) { const { hw, hh } = structureHalfExtents(p.kind, p.rot ?? 0); ex = Math.max(ex, Math.abs(p.x) + hw, Math.abs(p.y) + hh); }

    // Pick a Capital spot around chunk (-8, 6): clear itself, in bounds, with
    // at least one generated link across a field rock, then the most slots on
    // rocks (dense), then the most links across. (Ranking links first picked a
    // sparse spot once the catalogue v14 layout grew: the site with the most
    // crossings has no slot on a rock, while dense sites with crossings exist.)
    let site: { x: number; y: number; slotsOnRock: number; linksAcross: number } | null = null;
    const steps = 24, cx0 = -9 * CHUNK_SIZE, cy0 = 5 * CHUNK_SIZE;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const x = cx0 + (i / steps) * 3 * CHUNK_SIZE, y = cy0 + (j / steps) * 3 * CHUNK_SIZE;
        if (clampToSectorBounds(x - ex, y - ex).clamped || clampToSectorBounds(x + ex, y + ex).clamped) continue;
        const rocks = shaped(x - ex, y - ex, x + ex, y + ex);
        const cap = grown.placements.find((p) => p.kind === 'capital');
        if (cap && onRock('capital', x + cap.x, y + cap.y, cap.rot ?? 0, rocks)) continue;
        const hit = grown.placements.map((p) => onRock(p.kind, x + p.x, y + p.y, p.rot ?? 0, rocks));
        const slotsOnRock = hit.filter(Boolean).length;
        // Links whose ends are both clear but whose line crosses a rock: what
        // would run through the field if links did not see it.
        let linksAcross = 0;
        for (const [a, b] of grown.edges) {
          if (hit[a] || hit[b]) continue;
          const pa = grown.placements[a]!, pb = grown.placements[b]!;
          if (rocks.some((r) => segmentHitsObstacle(x + pa.x, y + pa.y, x + pb.x, y + pb.y, r))) linksAcross++;
        }
        if (slotsOnRock === grown.placements.length) continue;
        const score = (c: { slotsOnRock: number; linksAcross: number }): number => (c.linksAcross > 0 ? 1e6 : 0) + c.slotsOnRock * 100 + c.linksAcross;
        if (!site || score({ slotsOnRock, linksAcross }) > score(site)) site = { x, y, slotsOnRock, linksAcross };
      }
    }
    expect(site, 'a clear Capital spot in the field').not.toBeNull();
    console.log(`[C5f] base at (${site!.x}, ${site!.y}): ${grown.placements.length} slots, ${site!.slotsOnRock} on rocks, ${site!.linksAcross} links across rocks`);
    expect(site!.slotsOnRock, 'the base lands where the field is dense').toBeGreaterThan(0);
    expect(site!.linksAcross, 'some generated links would cross a rock').toBeGreaterThan(0);

    harness = await bootSectorTestServer({
      sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0, defaultSpawnX: 60_000, defaultSpawnY: 0,
      npcBases: [{ ...base, features: [...(base.features ?? [])], x: site!.x, y: site!.y }],
    });
    await harness.connectActive(randomUUID()); // the room is created on the first join
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const placed = [...int.structureRegistry.all()];
    expect(placed.length, 'the base was seeded').toBeGreaterThan(0);
    expect(placed.every((s) => s.owner === 'npc:traders:f1')).toBe(true);
    expect(placed.some((s) => s.kind === 'capital'), 'the Capital is placed').toBe(true);

    for (const s of placed) {
      const rot = s.rot ?? 0, { hw, hh } = structureHalfExtents(s.kind, rot);
      const rocks = shaped(s.x - hw * 2, s.y - hh * 2, s.x + hw * 2, s.y + hh * 2);
      expect(placementRejection(s.kind, s.x, s.y, [], rocks, rot), `${s.kind} at (${s.x.toFixed(0)}, ${s.y.toFixed(0)}) sits on a field rock`).toBeNull();
    }

    // Each stored link's real cable (the socket pair `canConnect` picked).
    const poly = new Float64Array(CABLE_CURVE_FLOATS), cbox = makeCableBox();
    let links = 0;
    for (const c of int.structureRegistry.allConnections()) {
      const a = int.structureRegistry.get(c.aId)!, b = int.structureRegistry.get(c.bId)!;
      links++;
      flattenLinkCable(structureToGridNode(a), c.socketA, structureToGridNode(b), c.socketB, poly, cbox);
      const rocks = shaped(cbox.x0, cbox.y0, cbox.x1, cbox.y1);
      let hitRock: GridObstacle | undefined;
      for (let sg = 0; sg < CABLE_CURVE_SEGMENTS && !hitRock; sg++) {
        const j = sg * 2;
        hitRock = rocks.find((r) => segmentHitsObstacle(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, r));
      }
      expect(hitRock, `link ${a.kind}(${a.x.toFixed(0)}, ${a.y.toFixed(0)}) - ${b.kind}(${b.x.toFixed(0)}, ${b.y.toFixed(0)}) cable crosses a field rock`).toBeUndefined();
    }
    expect(links, 'the base is linked').toBeGreaterThan(0);
  });
});
