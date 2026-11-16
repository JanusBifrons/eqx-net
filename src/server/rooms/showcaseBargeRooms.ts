/** Showcase rooms for the mining-barge looks (split out of `showcaseRooms.ts`). */
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
  /** Join `?shipKind=barge-look` to fly the look (the engines close-up). */
  pilotCapitals: true,
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

/** The barge look rooms, spread into `SHOWCASE_ROOMS`. */
export const SHOWCASE_BARGE_ROOMS = {
  'showcase-barge-look': SHOWCASE_BARGE_LOOK_OPTS,
  'showcase-barge-thrust': SHOWCASE_BARGE_THRUST_OPTS,
} as const;
