import type { Shot } from '../types.js';
import { xpForKill, xpToNext } from '../../src/core/leveling/shipXp.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';

/** M34, M8 — a kill crosses the XP threshold: level-up icon, badge, upgrade modal. */
export const levelUp: Shot = {
  id: 'level-up',
  section: 'mechanics',
  title: 'Veteran ships',
  caption: 'Each hull earns XP from its own kills — level up and spend points on hull, shields, speed or damage.',
  features: ['M34', 'M8'],
  docs: ['leveling-and-upgrades'],
  reel: true,
  server: 'lean',
  target: {
    room: 'showcase-levelup',
    params: {
      shipKind: 'interceptor',
      startHostile: 1,
      // One kill of the room's heavy crosses the first threshold.
      initialXp: xpToNext(1) - xpForKill(getShipKind('heavy').maxHealth),
    },
  },
  hud: 'clean',
  durationMs: 13_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 40, zoom: 2.0 } }],
};
