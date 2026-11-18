/** Showcase rooms for the mining barge: its looks and its mining take (split out of `showcaseRooms.ts`). */
import { isShipKindId } from '../../shared-types/shipKinds.js';

/**
 * Mining-barge look options (plan partitioned-chasing-lark, PR 14): the look
 * picked by `EQX_BARGE_LOOK` (A|B|C, server) and `?bargeLook=` (page) parked
 * nose up, a battleship off its starboard side and a few sub-caps off its port
 * side, for scale. Without the switch the barge pose is left out.
 */
function bargeLookPoses(): Array<{ kind: string; x: number; y: number; angle: number }> {
  const poses: Array<{ kind: string; x: number; y: number; angle: number }> = [{ kind: 'battleship', x: 2000, y: 0, angle: 0 }];
  if (isShipKindId('barge-look')) poses.push({ kind: 'barge-look', x: 0, y: 0, angle: 0 });
  const subs = ['fighter', 'heavy', 'gunship', 'interceptor', 'missile-frigate'];
  subs.forEach((kind, i) => poses.push({ kind, x: -1150 - (i % 2) * 160, y: -900 + i * 260, angle: 0 }));
  return poses;
}
export const SHOWCASE_BARGE_LOOK_OPTS = {
  testMode: true,
  asteroidConfig: [],
  peacefulDrones: true,
  dronePoses: bargeLookPoses(),
  defaultSpawnX: -1400,
  defaultSpawnY: -4600,
  maxClients: 4,
};

/** The barge look under way (an NPC on a scripted straight line at about
 *  60 % of its top speed, so its engines run at full thrust), for the stern
 *  close-up; the pilot (a fighter) watches from off its beam. */
export const SHOWCASE_BARGE_THRUST_OPTS = {
  ...SHOWCASE_BARGE_LOOK_OPTS,
  dronePoses: isShipKindId('barge-look')
    ? [{ kind: 'barge-look', x: 0, y: 0, angle: 0, vy: 60, path: { toX: 0, toY: 400_000, speed: 70, loop: false } }]
    : [],
  defaultSpawnX: -6000,
  defaultSpawnY: 0,
};

/**
 * The mining barge working a rock field (showcase shot `barge-mining`): the
 * pilot flies the barge (kind `barge`, nose along +y), with eight placed
 * rocks of mixed sizes in a loose ring round the origin. Every rock (radius 160–480) is
 * far too heavy for any tractor (size tier none), so the lasers must cut it
 * down the size ladder first. No other ship: nothing else fires. The barge's
 * closest zoom still fits its whole hull (~0.13 px/u at 1080p), so the rocks
 * are big enough to read there.
 * The barge starts with mine-rock-a off its port bow
 * (`SHOWCASE_BARGE_MINING_SPAWN`, also the integration take's pose,
 * `bargeMiningTake.test.ts`): a whole rock is size tier none, so only the bow
 * XL lasers cut it, and from the origin the rock sat abaft their arc.
 * Roster-backed (a real sectorKey, NOT in the galaxy graph): the barge has a
 * hold, so the pieces it consumes go in and the ore shows in it. With no
 * roster it has no hold, takes nothing in, and its lasers cut to the floor.
 */
export const SHOWCASE_BARGE_MINING_ROCKS = [
  { id: 'mine-rock-a', x: 1150, y: 400, vx: 0, vy: 0, radius: 260 },
  { id: 'mine-rock-b', x: 1250, y: -1200, vx: 0, vy: 0, radius: 200 },
  { id: 'mine-rock-c', x: 1300, y: 2000, vx: 0, vy: 0, radius: 160 },
  { id: 'mine-rock-d', x: 400, y: -3300, vx: 0, vy: 0, radius: 380 },
  { id: 'mine-rock-e', x: -1200, y: 700, vx: 0, vy: 0, radius: 200 },
  { id: 'mine-rock-f', x: -2100, y: -1600, vx: 0, vy: 0, radius: 480 },
  { id: 'mine-rock-g', x: -1250, y: 2300, vx: 0, vy: 0, radius: 180 },
  { id: 'mine-rock-h', x: 2700, y: 2600, vx: 0, vy: 0, radius: 250 },
];
/** Barge spawn (nose +y) with mine-rock-a off its port bow: inside the port
 *  XL laser's arc and the port XL tractor's reach, and on screen at the
 *  barge's closest zoom (upper left, clear of the HUD) where a rock dead
 *  ahead of the bow sits under the top bar (the follow camera centres the
 *  hull and has no look-ahead). The hull is clear of every other rock.
 *  Close in (the port XL tractor ~1,000 u from the rock): only that one dish
 *  bears, and its pull falls with the square of the range, so from ~2,500 u
 *  each piece took ~2.5 game minutes to reel in. */
export const SHOWCASE_BARGE_MINING_SPAWN = { x: 2600, y: -1800 };
export const SHOWCASE_BARGE_MINING_OPTS = {
  sectorKey: 'showcase-barge-mining',
  testMode: true,
  droneCount: 0,
  peacefulDrones: true,
  asteroidConfig: SHOWCASE_BARGE_MINING_ROCKS,
  defaultSpawnX: SHOWCASE_BARGE_MINING_SPAWN.x,
  defaultSpawnY: SHOWCASE_BARGE_MINING_SPAWN.y,
  maxClients: 4,
};

/** The barge rooms, spread into `SHOWCASE_ROOMS`. */
export const SHOWCASE_BARGE_ROOMS = {
  'showcase-barge-look': SHOWCASE_BARGE_LOOK_OPTS,
  'showcase-barge-thrust': SHOWCASE_BARGE_THRUST_OPTS,
  'showcase-barge-mining': SHOWCASE_BARGE_MINING_OPTS,
} as const;
