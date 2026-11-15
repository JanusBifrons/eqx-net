import type { Shot } from '../types.js';
import { slicedFieldLanes } from '../../src/core/terrain/fieldLayout.js';
import { cutFieldOpts } from '../../src/core/terrain/chunkStreamer.js';

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
