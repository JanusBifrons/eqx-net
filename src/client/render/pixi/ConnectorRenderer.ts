/**
 * Draws the grid connector web (speed-dial-resource-structures plan, Phase 3).
 * One `Graphics` cleared + redrawn each frame. Reads `mirror.structures` (the
 * web edges + build state) and joins to `mirror.swarm` for endpoint positions
 * (structures are static, so the resolved `entry.x/y` is stable — re-read it,
 * never re-interpolate, per the one-pose-per-frame rule).
 *
 * Each edge is drawn ONCE (from the lower entityId side) so reciprocal `connTo`
 * lists don't double-draw. A blueprint also gets a small construction
 * fill-bar above it. Allocation-free per frame: the flash key is packed
 * numerically (no string keys), and no per-frame collections are created.
 */
import { Graphics } from 'pixi.js';
import type { RenderMirror, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { connectorVisualParams, previewLineVisualParams } from './connectorVisual.js';
import {
  canConnect,
  type GridNode,
  type GridObstacle,
} from '../../../core/structures/Grid.js';
import type { Connection } from '../../../core/structures/Connection.js';
import {
  structureMirrorToGridNode,
  ghostToGridNode,
  asteroidObstaclesFromSwarm,
} from '../../structures/mirrorToGridNode.js';

/** A blank `GridNode` — fields are overwritten in place by the projection
 *  helpers. */
function blankGridNode(): GridNode {
  return {
    id: '',
    x: 0,
    y: 0,
    radius: 0,
    isHub: false,
    isCapital: false,
    maxConnections: 0,
    powerOutput: 0,
    powerConsumption: 0,
    isConstructed: false,
  };
}

export class ConnectorRenderer {
  readonly gfx = new Graphics();

  /**
   * Item C — number of 'ok' (would-connect) preview lines the LAST `update()`
   * drew for the current placement ghost. 0 when no preview is up. The
   * `PixiRenderer` reads this into `RendererFeedback.placementPreviewConnectionCount`
   * each frame; the renderer-level E2E asserts on it.
   */
  placementPreviewConnectionCount = 0;

  // ── Item C preview-pass module-scratch (invariant #14) ────────────────────
  // All reused in place; the preview pass runs ONLY while a ghost is up, so
  // these stay empty/untouched during normal play.
  /** Reused obstacle array (asteroids), refilled in place each preview frame. */
  private readonly _previewObstacles: GridObstacle[] = [];
  /** Reused ghost node (node `a` passed to `canConnect`). */
  private readonly _ghostNode: GridNode = blankGridNode();
  /** Reused node map for the LOS check (`canConnect` clips the segment against
   *  every OTHER node) — `.clear()`ed + repopulated each preview frame from a
   *  growable pool of node objects. */
  private readonly _previewNodes = new Map<string, GridNode>();
  /** Growable pool backing `_previewNodes` — never shrinks; objects are
   *  rewritten in place by `structureMirrorToGridNode`. */
  private readonly _nodePool: GridNode[] = [];
  /** Reused adjacency map for `canConnect` — value arrays carry only the right
   *  `.length` (the per-structure connection count) so the `b-full` check is
   *  faithful; the ghost (`a`) has no entry so it's never a duplicate. The
   *  array contents are never read, so a shared frozen dummy fill is safe. */
  private readonly _previewAdjacency = new Map<string, readonly Connection[]>();
  /** Growable pool of length-only adjacency arrays (one per structure). */
  private readonly _adjPool: Connection[][] = [];

  /** Redraw the web for this frame. `scale` is the viewport zoom. */
  update(mirror: RenderMirror, scale: number, nowMs: number): void {
    const g = this.gfx;
    g.clear();
    const structures = mirror.structures;
    const swarm = mirror.swarm;
    // The preview can run even with zero PLACED structures (the ghost still
    // wants to know there's nothing to connect to), but it needs the swarm to
    // resolve poses + asteroids. Reset the count up front so a frame with no
    // preview always publishes 0.
    this.placementPreviewConnectionCount = 0;
    if (swarm) this.drawPlacementPreview(mirror, swarm, scale);
    if (!structures || !swarm || structures.size === 0) return;
    const flashes = mirror.gridFlashes;

    for (const [id, st] of structures) {
      const a = swarm.get(id);
      if (!a) continue;
      // Pixi screen space is Y-down; world is Y-up — negate y (same as sprites).
      const ax = a.x;
      const ay = -a.y;

      for (const otherId of st.connTo) {
        // Draw each undirected edge once, from the lower-id endpoint.
        if (id > otherId) continue;
        const b = swarm.get(otherId);
        if (!b) continue;
        const lo = id < otherId ? id : otherId;
        const hi = id < otherId ? otherId : id;
        const flashUntil = flashes ? (flashes.get(lo * 65536 + hi) ?? 0) : 0;
        const v = connectorVisualParams(flashUntil, nowMs, scale);
        const bx = b.x;
        const by = -b.y;
        // Glow underlay first (so the core line sits on top).
        if (v.glowAlpha > 0) {
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.stroke({ color: v.color, alpha: v.glowAlpha, width: v.glowWidth });
        }
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke({ color: v.color, alpha: v.alpha, width: v.width });
      }

      // Phase 4 — mining beam from a miner to its target asteroid (positions
      // joined from the swarm mirror by entityId).
      if (st.miningTargetId !== undefined) {
        const target = swarm.get(st.miningTargetId);
        if (target) {
          const tx = target.x;
          const ty = -target.y;
          g.moveTo(ax, ay);
          g.lineTo(tx, ty);
          g.stroke({ color: 0xee8844, alpha: 0.85, width: Math.max(1 / scale, 2) });
        }
      }

      // Phase 5 — turret aim line toward its target drone (the fire beam
      // itself arrives as a discrete laser_fired). Faint dashed-feel via low
      // alpha; the actual shot is the bright beam.
      if (st.turretTargetId !== undefined) {
        const target = swarm.get(st.turretTargetId);
        if (target) {
          g.moveTo(ax, ay);
          g.lineTo(target.x, -target.y);
          g.stroke({ color: 0xff5555, alpha: 0.35, width: Math.max(1 / scale, 1) });
        }
      }

      // Construction fill-bar for blueprints (above the structure body).
      if (!st.built) {
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * Math.min(1, Math.max(0, st.buildPct)), barH);
        g.fill({ color: 0x66ccff, alpha: 0.9 });
      } else if (st.deconstructPct > 0) {
        // Red emptying bar while reclaiming.
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * Math.min(1, Math.max(0, 1 - st.deconstructPct)), barH);
        g.fill({ color: 0xff5555, alpha: 0.9 });
      }
    }
  }

  /**
   * Item C — draw the connection-range preview for the placement ghost and set
   * `placementPreviewConnectionCount`. Runs ONLY while `pendingPlacementPreview`
   * is set, so the scratch below stays cold during normal play (invariant #14:
   * everything is reused in place — the obstacle array, the ghost node, the node
   * map + its pool, the adjacency map + its pool).
   *
   * Uses the SAME obstacle-aware `canConnect` the server runs in
   * `autoConnectStructure`, so the preview's green/red/skip verdict per segment
   * matches what placement will actually do (no re-derived blocking).
   *
   * `ghostX/ghostY` override the preview pose so the lines emanate from where
   * the ghost is ACTUALLY drawn (the pointer-chosen point); when omitted (the
   * direct renderer-level test) it falls back to the preview pose.
   */
  private drawPlacementPreview(
    mirror: RenderMirror,
    swarm: ReadonlyMap<number, SwarmRenderState>,
    scale: number,
  ): void {
    const preview = mirror.pendingPlacementPreview;
    if (!preview) return;

    const ghostX = this.ghostWorldX ?? preview.x;
    const ghostY = this.ghostWorldY ?? preview.y;
    const ghost = ghostToGridNode({ kind: preview.kind, x: ghostX, y: ghostY }, this._ghostNode);

    // Build the obstacle list (asteroids) + the node map + adjacency for the
    // SAME canConnect the server uses, all into reused scratch.
    const obstacles = asteroidObstaclesFromSwarm(swarm, this._previewObstacles);

    const nodes = this._previewNodes;
    nodes.clear();
    const adjacency = this._previewAdjacency;
    adjacency.clear();
    const structures = mirror.structures;
    let poolIdx = 0;
    if (structures) {
      for (const [id, st] of structures) {
        const entry = swarm.get(id);
        if (!entry) continue;
        let node = this._nodePool[poolIdx];
        if (node === undefined) {
          node = blankGridNode();
          this._nodePool[poolIdx] = node;
        }
        const sid = String(id);
        structureMirrorToGridNode(sid, st, entry, node);
        nodes.set(sid, node);
        // Length-only adjacency: the value array carries the structure's current
        // connection count so the `b-full` check is faithful. Contents unread.
        let adj = this._adjPool[poolIdx];
        if (adj === undefined) {
          adj = [];
          this._adjPool[poolIdx] = adj;
        }
        adj.length = st.connTo.length;
        adjacency.set(sid, adj as readonly Connection[]);
        poolIdx++;
      }
    }

    const g = this.gfx;
    const ax = ghostX;
    const ay = -ghostY; // Pixi screen space is Y-down; world is Y-up.
    let okCount = 0;
    for (const node of nodes.values()) {
      const res = canConnect(ghost, node, adjacency, nodes, obstacles);
      let lineKind: 'ok' | 'blocked' | 'skip';
      if (res.ok) {
        lineKind = 'ok';
        okCount++;
      } else if (res.reason === 'blocked') {
        lineKind = 'blocked';
      } else {
        // out-of-range / hub-required / full / self / duplicate → not drawn.
        lineKind = 'skip';
      }
      if (lineKind === 'skip') continue;
      const v = previewLineVisualParams(lineKind, scale);
      const bx = node.x;
      const by = -node.y;
      if (v.glowAlpha > 0) {
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke({ color: v.color, alpha: v.glowAlpha, width: v.glowWidth });
      }
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke({ color: v.color, alpha: v.alpha, width: v.width });
    }
    this.placementPreviewConnectionCount = okCount;
  }

  /** Item C — override the ghost world position (pointer-chosen point) so the
   *  preview lines emanate from where the ghost is actually drawn. `null`
   *  reverts to the preview pose. Set by `PixiRenderer.update` before
   *  `connectorRenderer.update(...)`. */
  ghostWorldX: number | null = null;
  ghostWorldY: number | null = null;

  destroy(): void {
    this.gfx.destroy();
  }
}
