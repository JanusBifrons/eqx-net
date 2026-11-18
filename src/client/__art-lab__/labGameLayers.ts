/**
 * The game's own structure renderers in the art lab (split out of `main.ts`):
 * restyle 2c rig views and the grid lines (`ConnectorRenderer` over a
 * minimal render mirror). Built once at scene load.
 */
import type { Container } from 'pixi.js';
import { ConnectorRenderer } from '../render/pixi/ConnectorRenderer.js';
import { readLineLook } from '../render/pixi/connectorLineLooks.js';
import { StructureRigView, type StructureRigInput } from '../render/pixi/structureRigs.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { structScale, type Scene } from './scenes.js';

export interface LabRig { i: number; view: StructureRigView; input: StructureRigInput | null }

/** Rigs (restyle 2c): one view per structure whose kind has a rig, its
 *  groups placed in the lab's under / plane / over layers. */
export function buildLabRigs(scene: Scene, rigUnderL: Container, rigPlaneL: Container, rigOverL: Container): LabRig[] {
  const rigs: LabRig[] = [];
  scene.structs.forEach((st, i) => {
    const rig = rigForStructureKind(st.id);
    if (rig === null) return;
    const view = new StructureRigView(rig);
    const k = structScale(st);
    for (const [g, layer] of [[view.under, rigUnderL], [view.plane, rigPlaneL], [view.over, rigOverL]] as const) {
      g.position.set(st.x, st.y); g.rotation = st.rot; g.scale.set(k);
      layer.addChild(g);
    }
    rigs.push({ i, view, input: null });
  });
  return rigs;
}

/** Grid lines: the game's ConnectorRenderer over a minimal mirror (game
 *  space is y-up, so y flips; entity ids are struct index + 1). Null when the
 *  scene has no edges. */
export function buildLabGridLines(scene: Scene, lineL: Container): { r: ConnectorRenderer; mirror: RenderMirror } | null {
  if (!(scene.edges && scene.edges.length > 0)) return null;
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  scene.structs.forEach((st, i) => {
    swarm.set(i + 1, {
      x: st.x, y: -st.y, vx: 0, vy: 0, angle: -st.rot, angvel: 0,
      prevX: st.x, prevY: -st.y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: getStructureKind(st.id).radius * structScale(st), kind: 2, shipKind: st.id, sleeping: true, lastUpdateTick: 0,
    } as unknown as SwarmRenderState);
    structures.set(i + 1, { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: true } as unknown as StructureRenderState);
  });
  for (const [a, b] of scene.edges) {
    structures.get(a + 1)!.connTo.push(b + 1);
    structures.get(b + 1)!.connTo.push(a + 1);
  }
  const r = new ConnectorRenderer();
  r.lineLook = readLineLook(location.search); // 1g `?lineLook=`: odd edges carry flow so the look's pulse shows
  const gridFlashes = r.lineLook ? new Map(scene.edges.filter((_, i) => i % 2 === 1).map(([p, q]) => [(Math.min(p, q) + 1) * 65536 + Math.max(p, q) + 1, 1e12])) : undefined;
  lineL.addChild(r.staticGfx, r.gfx);
  return { r, mirror: { swarm, structures, gridFlashes } as unknown as RenderMirror };
}
