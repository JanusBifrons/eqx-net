/**
 * The Power numbers a building shows: its own draw now (output minus draw),
 * whether it draws idle or full, and the grid's net. Pure: everything comes
 * from the client-resident structure slice (snapshot, #16) plus the catalogue,
 * the same figures the inspector's PWR line reads. No new wire data.
 */
import { getStructureKind } from '@shared-types/structureKinds';
import { structureDraw } from '@shared-types/structurePower';
import { effectiveStructurePowerOutput } from '@core/leveling/structureLevel';
import type { StructureRenderState } from '@core/contracts/IRenderer';

type PowerSlice = Pick<StructureRenderState, 'drawFull' | 'level'>;

/** This building's own power figure: level-scaled output minus what it draws
 *  NOW (full while active, else the idle trickle). +gen, −drain, 0 passive. */
export function structureSelfPower(kindId: string, st: PowerSlice): number {
  const k = getStructureKind(kindId);
  return effectiveStructurePowerOutput(k.powerOutput, st.level) - Math.round(structureDraw(k.powerConsumption, st.drawFull === true));
}

export interface PowerSummary {
  /** Own power now (see `structureSelfPower`). */
  selfPower: number;
  /** 'full' / 'idle' for a building that draws power; 'none' when it never draws. */
  load: 'full' | 'idle' | 'none';
  /** The whole grid's net power (shared by every member). */
  gridNet: number;
  powered: boolean;
}

export function powerSummary(kindId: string, st: PowerSlice & Pick<StructureRenderState, 'netPower' | 'powered'>): PowerSummary {
  const draws = getStructureKind(kindId).powerConsumption > 0;
  return {
    selfPower: structureSelfPower(kindId, st),
    load: !draws ? 'none' : st.drawFull === true ? 'full' : 'idle',
    gridNet: Math.round(st.netPower),
    powered: st.powered,
  };
}

/** "+35", "-15", "0". */
export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}
