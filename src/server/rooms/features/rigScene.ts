/**
 * Structure rigs driven from the room (structure-restyle 2d / 2f), moved out
 * of SectorRoom: start a rig clip on a structure and write its room-state
 * row, and the articulation sandbox's scene hooks (`moveShip`, `rigClip`).
 */
import { ScriptedPathBehaviour } from '../../../core/ai/ScriptedPathBehaviour.js';
import { shipBodyMass } from '../../../shared-types/shipScale/tuning.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../../shared-types/sabLayout.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import { rigClipTip, startStructureRigClip, worldToRigHost, writeRigClipRow, type RigClipCmd } from '../../structures/structureRigClip.js';
import type { SceneHooks, SceneRigTarget } from '../scene/SceneScriptRunner.js';
import type { StructureState } from '../schema/SectorState.js';

export interface RigSceneHost {
  structures: Pick<StructureRegistry, 'get' | 'all'>;
  swarm: Pick<SwarmEntityRegistry, 'get'>;
  sab: () => Float32Array;
  serverTick: () => number;
  post: (cmd: RigClipCmd) => void;
  /** The structure's room-state row by `stateKey`. */
  stateRow: (key: string) => StructureState | undefined;
  /** `AiController.register` (the sandbox's scripted mover). */
  registerAi: (id: string, slot: number, behaviour: ScriptedPathBehaviour) => void;
}

export class RigScene {
  constructor(private readonly h: RigSceneHost) {}

  /** Start (or, with null, clear) rig clip `clipId` on structure `id` from
   *  this tick, with an optional target in the structure's frame. Records
   *  `StructureRecord.rigClip` and moves the rig's solid parts in the physics
   *  worker. False when the structure, its rig or the clip is unknown. Writes
   *  the structure's room-state row now (2e), so the clip reaches clients in
   *  the next patch, not the next pulse. */
  start(
    id: string, clipId: string | null, target?: { readonly x: number; readonly y: number },
    hold?: { readonly holdTicks: number; readonly cargo: number },
  ): boolean {
    const rec = this.h.structures.get(id);
    if (!rec) return false;
    if (!startStructureRigClip(rec, clipId, this.h.serverTick(), this.h.post, target, hold)) return false;
    const st = rec.stateKey !== undefined ? this.h.stateRow(rec.stateKey) : undefined;
    if (st) writeRigClipRow(rec, st);
    return true;
  }

  /** The sandbox's scene hooks. */
  sceneHooks(): Pick<SceneHooks, 'moveShip' | 'rigClip'> {
    return {
      // Articulation sandbox (structure-restyle 2f): the radar sandbox's
      // scripted mover, re-aimed from where the ship is now, nose first.
      moveShip: (id, x, y, speed) => {
        const rec = this.h.swarm.get(id);
        if (!rec) return false;
        const b = slotBase(rec.slot), sab = this.h.sab();
        this.h.registerAi(id, rec.slot, new ScriptedPathBehaviour({
          from: { x: sab[b + SLOT_X_OFF]!, y: sab[b + SLOT_Y_OFF]! },
          to: { x, y }, speed, loop: false, faceTurnRate: 1.5,
        }, shipBodyMass(getShipKind(rec.shipKind))));
        return true;
      },
      // Scripted crane for the sandbox film: its hauler is an unowned swarm
      // ship, which the bay dwell (`dockDwell`, owner's ships only) never
      // serves. A pilot parking on the dock drives the real dwell.
      rigClip: (kind, clip, target) => this.sceneRigClip(kind, clip, target),
    };
  }

  private sceneRigClip(kind: string, clip: string | null, target: SceneRigTarget): boolean {
    let host: StructureRecord | undefined;
    for (const r of this.h.structures.all()) if (r.kind === kind) { host = r; break; }
    if (!host) return false;
    let t: { x: number; y: number } | undefined;
    if (target.from === 'ship') {
      const ship = this.h.swarm.get(target.id);
      if (!ship) return false;
      const b = slotBase(ship.slot), sab = this.h.sab();
      t = worldToRigHost(host, sab[b + SLOT_X_OFF]!, sab[b + SLOT_Y_OFF]!);
    } else if (target.from === 'keep') {
      t = host.rigClip?.target;
    } else if (target.from === 'tip') {
      t = rigClipTip(host, this.h.serverTick()) ?? undefined;
    }
    if (target.from !== 'none' && t === undefined) return false;
    return this.start(host.id, clip, t);
  }
}
