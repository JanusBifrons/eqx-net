/**
 * The entity stats panel's rows for indestructible swarm terrain: an asteroid
 * and a cargo pod (split out of EntityStatsPanel.tsx, god-file cap). Both read
 * the render mirror directly and show no hull bar.
 */
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import { isLootPod } from '@shared-types/swarmWireFormat';
import { podSizeOf } from '@shared-types/shipKinds/cargoPod';
import { withinLootOpenReach } from '@core/cargo/lootReach';

/** The panel fields a terrain row fills (a subset of the panel's data). */
export interface TerrainPanelRow {
  name: string; hpPct: number; shieldPct: null; noHull: true; infoLine: string;
  entityId?: number; podOpen?: boolean;
}

/** ASTEROID (R2.23) — indestructible rock: no hull bar; show resources when the
 *  rock is being mined, else a SIZE proxy from radius (untouched rocks carry no
 *  resources/mass on the wire — real mass is a future server-touching change). */
export function asteroidPanelRow(sw: SwarmRenderState): TerrainPanelRow {
  const hasRes = sw.resourcesMax !== undefined && sw.resourcesMax > 0;
  return {
    name: 'Asteroid',
    hpPct: 0,
    shieldPct: null,
    noHull: true,
    infoLine: hasRes
      ? `RES ${Math.round(sw.resources ?? 0)} / ${Math.round(sw.resourcesMax!)}`
      : `SIZE ${Math.round(sw.radius)}`,
  };
}

/** Pod size class → the panel's size line (a fighter's pod up to a capital's). */
const POD_SIZE_NAMES: readonly string[] = ['Small', 'Medium', 'Large', 'Huge'];

/** CARGO POD (cargo pods 15/16) — indestructible loot: no hull bar; Open
 *  works within about a ship length (the server re-checks every request).
 *  Null when `sw` is not a loot pod. */
export function podPanelRow(mirror: RenderMirror, swarmId: number, sw: SwarmRenderState): TerrainPanelRow | null {
  if (!isLootPod(sw)) return null;
  const localId = mirror.localPlayerId;
  const me = localId !== null ? mirror.ships.get(localId) : undefined;
  const near = me !== undefined && withinLootOpenReach(me.kind, me.shieldDown !== true, sw.x, sw.y, me.x, me.y, me.angle);
  return {
    name: 'Cargo pod', hpPct: 0, shieldPct: null, noHull: true,
    infoLine: POD_SIZE_NAMES[podSizeOf(sw.componentIndex ?? 0)] ?? '',
    entityId: swarmId, podOpen: near,
  };
}
