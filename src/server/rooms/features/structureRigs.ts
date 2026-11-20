/**
 * Structure-restyle wiring: builds the room's two structure-rig collaborators
 * from one narrow host, so `SectorRoom` holds a single field for both:
 *  - `RigScene` (2d / 2f): rig clips on placed structures and the sandbox
 *    scene hooks;
 *  - `CraneBays` (3h / 3i): auto-deposit, the crane bay cycle and convoy
 *    haulers' crane jobs, which start their arm clips through the RigScene.
 * Built once as a room class field; never on the tick.
 */
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import type { LootCollectors } from '../../cargo/LootCollectors.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { RigClipCmd } from '../../structures/structureRigClip.js';
import type { SectorState } from '../schema/SectorState.js';
import { CraneBays, type CraneBayHost } from './craneBays.js';
import { RigScene, type RigSceneHost } from './rigScene.js';

/** What the rigs read from the room; getters read the live field. */
export interface StructureRigsHost {
  structures(): Pick<StructureRegistry, 'get' | 'all' | 'size'>;
  swarm(): Pick<SwarmEntityRegistry, 'get'>;
  readonly lootCollectors: Pick<LootCollectors, 'forEach' | 'fillShip' | 'manualCargo' | 'onDeposited'>;
  sab(): Float32Array;
  serverTick(): number;
  /** The room's physics-worker post (rig attach / clip commands). */
  post(cmd: RigClipCmd): void;
  state(): Pick<SectorState, 'structures'>;
  registerAi: RigSceneHost['registerAi'];
  storage: CraneBayHost['storage'];
  shipHold: CraneBayHost['shipHold'];
}

export interface StructureRigs {
  readonly rigScene: RigScene;
  readonly craneBays: CraneBays;
}

export function buildStructureRigs(h: StructureRigsHost): StructureRigs {
  const rigScene = new RigScene({
    structures: { get: (id) => h.structures().get(id), all: () => h.structures().all() },
    swarm: { get: (id) => h.swarm().get(id) }, sab: h.sab, serverTick: h.serverTick,
    post: (cmd) => h.post(cmd), stateRow: (key) => h.state().structures.get(key),
    registerAi: h.registerAi,
  });
  const lc = h.lootCollectors;
  const craneBays = new CraneBays({
    structures: h.structures, lootCollectors: lc, manualCargo: lc.manualCargo,
    serverTick: h.serverTick, storage: h.storage, shipHold: h.shipHold,
    autoUnloadOn: (id) => getPlayerShipStore().get(id)?.autoUnload !== false,
    startStructureRigClip: (id, clip, target, hold) => rigScene.start(id, clip, target, hold),
    noteDeposited: (c, target, moved, loaded) => lc.onDeposited(c, target, moved, loaded),
  });
  return { rigScene, craneBays };
}
