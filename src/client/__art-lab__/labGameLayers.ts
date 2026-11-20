/**
 * The game's own structure renderers in the art lab (split out of `main.ts`):
 * restyle 2c rig views and the grid lines (`ConnectorRenderer` over a
 * minimal render mirror). Built once at scene load.
 */
import { Graphics, type Container } from 'pixi.js';
import { ConnectorRenderer } from '../render/pixi/ConnectorRenderer.js';
import { readLineLook } from '../render/pixi/connectorLineLooks.js';
import { StructureRigView, type StructureRigInput } from '../render/pixi/structureRigs.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import type { Scene } from './scenes.js';
import { CONNECTION_MAX_RANGE } from '../../core/structures/structureGridConstants.js';
import { CABLE_NO_SOCKET, makeCableSocketPick, pickCableSocketPair } from '../../core/structures/cableCurve.js';
import type { GridNode } from '../../core/structures/Grid.js';
import { blankGridNode, structureMirrorToGridNode } from '../structures/mirrorToGridNode.js';
import { resolveFxMode } from '../render/art/artMode.js';
import { bodyStatusCode, socketNubContext, socketUsedMask } from '../render/pixi/structureSocketNubs.js';

/** `spins`: the rig's spinning parts run (Family 1 reactor fans; off for a
 *  `?live=dry` reactor). The lab poses them as a pure function of t. */
export interface LabRig { i: number; view: StructureRigView; input: StructureRigInput | null; spins: boolean }

/** Rigs (restyle 2c): one view per structure whose kind has a rig, its
 *  groups placed in the lab's under / plane / over layers. */
export function buildLabRigs(scene: Scene, rigUnderL: Container, rigPlaneL: Container, rigOverL: Container, live: string | null = null): LabRig[] {
  const vals = live !== null ? live.split(',') : [];
  const rigs: LabRig[] = [];
  scene.structs.forEach((st, i) => {
    const rig = rigForStructureKind(st.id);
    if (rig === null) return;
    const view = new StructureRigView(rig);
    for (const [g, layer] of [[view.under, rigUnderL], [view.plane, rigPlaneL], [view.over, rigOverL]] as const) {
      g.position.set(st.x, st.y); g.rotation = st.rot;
      layer.addChild(g);
    }
    view.setRunningFrom(labLiveRow(st.id, vals[i]));
    rigs.push({ i, view, input: null, spins: view.running });
  });
  return rigs;
}

/** Grid lines: the game's ConnectorRenderer over a minimal mirror (game
 *  space is y-up, so y flips; entity ids are struct index + 1). Null when the
 *  scene has no edges. With the socket cables on (`?fx=new`), each structure's
 *  socket nubs (0d slice 10) go on top of `nubL`, from the same used sockets. */
export function buildLabGridLines(scene: Scene, lineL: Container, nubL?: Container): { r: ConnectorRenderer; mirror: RenderMirror } | null {
  if (!(scene.edges && scene.edges.length > 0)) return null;
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  scene.structs.forEach((st, i) => {
    swarm.set(i + 1, {
      x: st.x, y: -st.y, vx: 0, vy: 0, angle: -st.rot, angvel: 0,
      prevX: st.x, prevY: -st.y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: getStructureKind(st.id).radius, kind: 2, shipKind: st.id, sleeping: true, lastUpdateTick: 0,
    } as unknown as SwarmRenderState);
    structures.set(i + 1, { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: true } as unknown as StructureRenderState);
  });
  // 0d: each link's cable sockets, picked by the game's own rule over every
  // structure (the same pair the base generator linked with: its later
  // placements never land on an existing cable).
  const nodes = new Map<string, GridNode>();
  for (const [id, e] of swarm) nodes.set(String(id), structureMirrorToGridNode(String(id), structures.get(id)!, e, blankGridNode()));
  const pick = makeCableSocketPick();
  for (const [a, b] of scene.edges) {
    const sa = structures.get(a + 1)!, sb = structures.get(b + 1)!;
    const na = nodes.get(String(a + 1))!, nb = nodes.get(String(b + 1))!;
    // A fence link (emitter to emitter) stays straight post to post, as `canConnect`.
    const fence = na.isShieldPylon === true && nb.isShieldPylon === true;
    const ok = !fence && pickCableSocketPair(na, nb, CONNECTION_MAX_RANGE, nodes, undefined, pick) === null;
    const pa = ok ? pick.a : CABLE_NO_SOCKET, pb = ok ? pick.b : CABLE_NO_SOCKET;
    sa.connTo.push(b + 1); (sa.connSockSelf ??= []).push(pa); (sa.connSockOther ??= []).push(pb);
    sb.connTo.push(a + 1); (sb.connSockSelf ??= []).push(pb); (sb.connSockOther ??= []).push(pa);
  }
  const r = new ConnectorRenderer();
  r.socketCables = resolveFxMode(location.search, 'machined', true); // 0d socket cables: `?fx=new`
  r.lineLook = readLineLook(location.search); // 1g `?lineLook=`: odd edges carry flow so the look's pulse shows
  const gridFlashes = r.lineLook ? new Map(scene.edges.filter((_, i) => i % 2 === 1).map(([p, q]) => [(Math.min(p, q) + 1) * 65536 + Math.max(p, q) + 1, 1e12])) : undefined;
  lineL.addChild(r.staticGfx, r.gfx);
  if (r.socketCables && nubL) scene.structs.forEach((st, i) => {
    const g = new Graphics(socketNubContext(st.id, socketUsedMask(structures.get(i + 1)!.connSockSelf)));
    g.position.set(st.x, st.y); g.rotation = st.rot;
    nubL.addChild(g);
  });
  return { r, mirror: { swarm, structures, gridFlashes } as unknown as RenderMirror };
}

/** A lab structure row for `?live=` entry `v` (Stage 4 F1 step C): a
 *  number is a power store's charge fraction, `dry` a reactor with no fuel,
 *  anything else (`fuel`, empty) the plain built row. */
export function labLiveRow(kind: string, v: string | undefined): StructureRenderState {
  const row = { built: true, powered: true, buildPct: 1, deconstructPct: 0, connTo: [] } as unknown as StructureRenderState;
  const cap = getStructureKind(kind).powerStorageCapacity ?? 0;
  if (cap > 0 && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
    row.storedPowerMax = cap;
    row.storedPower = cap * Number(v);
  }
  if (v === 'dry') row.noFuel = true;
  return row;
}

/** Stud sheets (`?nubs=all|mix`, stud audit): with no grid lines in the
 *  scene, every structure's socket nubs straight from the socket list, all
 *  lit (`all`) or every other one lit (`mix`). `?live=a,b,...` (one entry
 *  per structure, `labLiveRow`) adds each one's live body state (charge
 *  cells, a dry reactor) on the same overlay, free sockets unless `nubs` is
 *  set. Null when off. */
export function buildLabSheetNubs(scene: Scene, nubL: Container, mode: string | null, live: string | null = null): number | null {
  if (mode !== 'all' && mode !== 'mix' && live === null) return null;
  const mask = mode === 'all' ? 0xffffffff : mode === 'mix' ? 0x55555555 : 0;
  const vals = live !== null ? live.split(',') : [];
  scene.structs.forEach((st, i) => {
    const status = live !== null ? bodyStatusCode(st.id, labLiveRow(st.id, vals[i])) : 0;
    const g = new Graphics(socketNubContext(st.id, mask, status));
    g.position.set(st.x, st.y); g.rotation = st.rot;
    nubL.addChild(g);
  });
  return scene.structs.length;
}
