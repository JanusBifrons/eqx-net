/**
 * The Power numbers a building shows: its own draw now (output minus draw),
 * whether it draws idle or full, and the grid's net. Pure: everything comes
 * from the client-resident structure slice (snapshot, #16) plus the catalogue,
 * the same figures the inspector's PWR line reads. No new wire data.
 */
import { getStructureKind } from '@shared-types/structureKinds';
import { canSwitchStructure, STRUCTURE_THROTTLE_FULL, structureDraw } from '@shared-types/structurePower';
import { effectiveStructurePowerOutput } from '@core/leveling/structureLevel';
import type { StructureRenderState } from '@core/contracts/IRenderer';

type PowerSlice = Pick<StructureRenderState, 'drawFull' | 'level' | 'switchedOff' | 'throttle'>;

/** This building's own power figure: level-scaled output minus what it draws
 *  NOW (full while active, else the idle trickle; 0 when Off, scaled by the throttle). +gen, −drain, 0 passive. */
export function structureSelfPower(kindId: string, st: PowerSlice): number {
  const k = getStructureKind(kindId);
  return effectiveStructurePowerOutput(k.powerOutput, st.level) - Math.round(structureDraw(k.powerConsumption, st.drawFull === true, st.switchedOff === true, st.throttle));
}

export interface PowerSummary {
  /** Own power now (see `structureSelfPower`). */
  selfPower: number;
  /** 'full' / 'idle' for a building that draws power; 'none' when it never draws. */
  load: 'full' | 'idle' | 'none';
  /** The whole grid's net power (shared by every member). */
  gridNet: number;
  powered: boolean;
  /** The owner's switch: false when switched Off. */
  on: boolean;
  /** The owner's throttle in tenths (10 = 100%, the default). */
  throttle: number;
}

export function powerSummary(kindId: string, st: PowerSlice & Pick<StructureRenderState, 'netPower' | 'powered'>): PowerSummary {
  const draws = getStructureKind(kindId).powerConsumption > 0;
  return {
    selfPower: structureSelfPower(kindId, st),
    load: !draws ? 'none' : st.drawFull === true ? 'full' : 'idle',
    gridNet: Math.round(st.netPower),
    powered: st.powered,
    on: st.switchedOff !== true,
    throttle: st.throttle ?? STRUCTURE_THROTTLE_FULL,
  };
}

/** The Power tab shows On/Off for a building the server lets its owner
 *  switch (`canSwitchStructure`: only kinds that draw power). */
export function hasPowerSwitch(kindId: string): boolean {
  return canSwitchStructure(getStructureKind(kindId).powerConsumption);
}

/** ...and a throttle only where it changes something: a turret has On/Off
 *  only (the throttle scales work speed, never fire rate). */
export function hasPowerThrottle(kindId: string): boolean {
  return hasPowerSwitch(kindId) && getStructureKind(kindId).weaponRange === undefined;
}

/** "+35", "-15", "0". */
export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

/** The inspector's PWR line. A generator always shows its output; a consumer
 *  shows its draw when powered, else UNPOWERED. An UNBUILT structure is not on
 *  the grid yet (the server reports it unpowered), so it is not drawing power:
 *  BUILDING, never UNPOWERED (owner play-test 2026-11-21, Shipyard on a +150 grid). */
export function inspectorPowerLine(selfPower: number, powered: boolean | undefined, built: boolean | undefined): string {
  if (selfPower > 0) return `PWR +${Math.round(selfPower)}`;
  if (built !== true) return 'BUILDING';
  return powered === true ? `PWR ${Math.round(selfPower)}` : 'UNPOWERED';
}
