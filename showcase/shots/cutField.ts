import type { Shot } from '../types.js';
import { slicedFieldLanes } from '../../src/core/terrain/fieldLayout.js';
import { cutFieldOpts } from '../../src/core/terrain/chunkStreamer.js';
import { flyRoute } from './_pilot.js';

/**
 * Cut-field test room stills (docs/architecture/macro-terrain.md, slice 3).
 * Stills first (owner rule). Capital lane 1 of the `look` field, 40 km in
 * from the lane origin, facing down the lane. The lane is ~9 km wide and
 * empty, so the close still parks the fighter just inside a lane wall, and the
 * overview pulls a spectator camera out over the loaded chunks. Rocks are the
 * flat-coloured slice-2 draw; client and server cut them from the seed.
 */
const lane = slicedFieldLanes(cutFieldOpts('look'))[1]!;
// Lane direction (n.y, -n.x); ship angle 0 faces +y, heading (-sin a, cos a).
const dx = lane.n.y, dy = -lane.n.x;
const T = 40_000;
const ANGLE = Math.round(Math.atan2(-dx, dy) * 1000) / 1000;
/** A point on the lane, `side` units off its centre line along the normal. */
const at = (side: number): { x: number; y: number } => ({
  x: Math.round(lane.o.x + dx * T + lane.n.x * side),
  y: Math.round(lane.o.y + dy * T + lane.n.y * side),
});
const CENTRE = at(0);
// 700 u off the nearest rock edge beside the lane wall (rock outline vertex
// at -30120, 26501, from rocksInChunk for seed `look`), facing it.
const WALL = { x: -30_002, y: 27_191 };
const WALL_ANGLE = 2.972;

const still = (id: string, title: string, shipKind: 'fighter' | 'battleship', p: { x: number; y: number }, angle = ANGLE): Shot => ({
  id,
  section: 'mechanics',
  title: `Cut field still: ${title}`,
  caption: 'A ship in a capital lane of the cut asteroid field (still for review).',
  features: ['ART'],
  docs: ['macro-terrain'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind, spawnX: p.x, spawnY: p.y, initialAngle: angle, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 14_000,
  async run(ctx) { await ctx.sleep(13_500); },
});

export const cutFieldLaneFighter = still('cut-field-lane-fighter', 'fighter beside a lane wall', 'fighter', WALL, WALL_ANGLE);
export const cutFieldLaneBattleship = still('cut-field-lane-battleship', 'battleship in a capital lane', 'battleship', CENTRE);

/** Spectator pull-out over the lane: the loaded chunks (7 × 7 around the
 *  ship, ~28 km) and the lane cutting through them. */
export const cutFieldOverview: Shot = {
  id: 'cut-field-overview',
  section: 'mechanics',
  title: 'Cut field overview: the lane from above',
  caption: 'A capital lane through the cut asteroid field, seen from far out (still for review).',
  features: ['ART'],
  docs: ['macro-terrain'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind: 'fighter', spawnX: CENTRE.x, spawnY: CENTRE.y, initialAngle: ANGLE, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 16_000,
  async startWhen(ctx) { await ctx.sleep(6000); await ctx.spectate(); },
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: CENTRE.x, y: CENTRE.y, zoom: 0.04 } },
    { atMs: 8000, smoothMs: 2000, shot: { kind: 'hold', x: CENTRE.x, y: CENTRE.y, zoom: 0.1 } },
  ],
};

/** The ore look (F1c): where a big ice lode (centre -28 406, 34 564) meets a
 *  crystal one (-30 026, 38 076) beside the lane, ~4 km from its centre (from
 *  `hotspotsInBox` for seed `look`). Spectator holds at the wide, capital and
 *  fighter zooms; film with `EQX_SHOWCASE_PARAMS=ore=<style>`. */
const ORE_EDGE = { x: -29_100, y: 36_070 };
export const cutFieldOre: Shot = {
  id: 'cut-field-ore',
  section: 'mechanics',
  title: 'Cut field ore: ice and crystal lodes',
  caption: 'Ice and crystal deposits showing in the rock where the ore map has them (still for review).',
  features: ['ART'],
  docs: ['macro-terrain'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind: 'fighter', spawnX: CENTRE.x, spawnY: CENTRE.y, initialAngle: ANGLE, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 20_000,
  async startWhen(ctx) { await ctx.sleep(6000); await ctx.spectate(); },
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: ORE_EDGE.x, y: ORE_EDGE.y, zoom: 0.05 } },
    { atMs: 6000, smoothMs: 0, shot: { kind: 'hold', x: ORE_EDGE.x, y: ORE_EDGE.y, zoom: 0.15 } },
    { atMs: 12000, smoothMs: 0, shot: { kind: 'hold', x: ORE_EDGE.x, y: ORE_EDGE.y, zoom: 0.5 } },
  ],
};

/** The fly-through (slice 3): a fighter down capital lane 1 on the follow
 *  camera, 3.7 km off the centre line on the side where the rock wall stays
 *  ~300–900 u away for 10 km (from rocksInChunk for seed `look`), so the wall
 *  streams past. Steered by the shared `flyRoute` pilot. */
const RUN_SIDE = -3700;
const runAt = (t: number): [number, number] => [
  Math.round(lane.o.x + dx * t + lane.n.x * RUN_SIDE),
  Math.round(lane.o.y + dy * t + lane.n.y * RUN_SIDE),
];
const [RUN_X, RUN_Y] = runAt(35_000);
export const cutFieldLaneRun: Shot = {
  id: 'cut-field-lane-run',
  section: 'mechanics',
  title: 'Cut field: a fighter down a capital lane',
  caption: 'A fighter flies down a capital lane of the cut asteroid field, the rock wall streaming past.',
  features: ['ART'],
  docs: ['macro-terrain'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind: 'fighter', spawnX: RUN_X, spawnY: RUN_Y, initialAngle: ANGLE, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 32_000,
  endsWithRun: true,
  async run(ctx) {
    await ctx.sleep(1500);
    await flyRoute(ctx, [runAt(38_000), runAt(41_000), runAt(44_000), runAt(47_000)], { cruise: 420, maxMs: 28_000 });
  },
};

/** Waking (plan C2): a battleship backs off the lane-1 wall rock the
 *  collision E2E rams (3.7 km off, clear of rocks, facing the wall) and
 *  ploughs in under thrust + boost. Each rock it touches wakes and is shoved
 *  aside: a rock weighs a battleship × (its radius / a battleship's)², so
 *  these ~300 u rocks are about 1 % of the ship. Follow camera, full HUD. */
const RAM_BACK = 3700;
const RAM_HEAD = { x: (-30_120 - WALL.x) / 700, y: (26_501 - WALL.y) / 700 };
export const cutFieldRam: Shot = {
  id: 'cut-field-ram',
  section: 'mechanics',
  title: 'Cut field: a battleship ploughs into the rocks',
  caption: 'A battleship rams the cut field: every rock it touches wakes and is shoved aside.',
  features: ['ART'],
  docs: ['macro-terrain'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-cut-field',
    params: {
      shipKind: 'battleship',
      spawnX: Math.round(WALL.x - RAM_HEAD.x * RAM_BACK),
      spawnY: Math.round(WALL.y - RAM_HEAD.y * RAM_BACK),
      initialAngle: WALL_ANGLE,
      initialHull: 1_000_000,
    },
  },
  hud: 'full',
  durationMs: 50_000,
  async run(ctx) {
    await ctx.sleep(2000);
    await ctx.hold(['w', 'Shift'], 46_000);
  },
};
