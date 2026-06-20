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
import { interpBuildPct } from './buildBarInterp.js';
import {
  connectorVisualInto,
  previewLineVisualParams,
  rangeCircleVisualParams,
  cometSegment,
  shieldWallVisualParams,
  type ConnectorVisual,
  type CometSegment,
  type ShieldWallVisual,
  type PreviewLineKind,
} from './connectorVisual.js';
import {
  canConnect,
  edgeDistance,
  type GridNode,
  type GridObstacle,
} from '../../../core/structures/Grid.js';
import {
  PLACEMENT_MAX_CONNECTIONS,
  CONNECTION_MAX_RANGE,
} from '../../../core/structures/structureGridConstants.js';
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
    isConnector: false,
    maxConnections: 0,
    powerOutput: 0,
    powerConsumption: 0,
    isConstructed: false,
  };
}

export class ConnectorRenderer {
  readonly gfx = new Graphics();

  /**
   * Item C — number of 'ok' (would-connect, GREEN, counted) preview lines the
   * LAST `update()` drew for the current placement ghost, capped at
   * `PLACEMENT_MAX_CONNECTIONS` (WS-5 R2.17). 0 when no preview is up. The
   * `PixiRenderer` reads this into `RendererFeedback.placementPreviewConnectionCount`
   * each frame; the renderer-level E2E asserts on it.
   */
  placementPreviewConnectionCount = 0;

  /**
   * WS-5 (R2.17) — number of 'overflow' (would-connect but past the cap, RED,
   * NOT counted) preview lines the LAST `update()` drew. 0 when no preview is up
   * or the in-range legal hubs are at/below the cap. Sibling test hook to
   * `placementPreviewConnectionCount` (the drawn lines aren't headlessly
   * inspectable, so this is the observable — feedback-test-observable lesson).
   *
   * WS-D (#6) — kept as the back-compat alias of `placementPreviewDeferredCount`
   * (the over-cap remainder is now drawn DOTTED green, not red).
   */
  placementPreviewOverflowCount = 0;

  /**
   * WS-D (#6) — number of SOLID-green 'selected' preview lines the LAST
   * `update()` drew: the hubs that WILL connect on confirm (capped at the placed
   * kind's `maxConnections` AND the global `PLACEMENT_MAX_CONNECTIONS`). Identical
   * to `placementPreviewConnectionCount`; named for the restyle's solid/dotted
   * split. 0 when no preview is up.
   */
  placementPreviewSelectedCount = 0;

  /**
   * WS-D (#6) — number of DOTTED-green 'deferred' preview lines the LAST
   * `update()` drew: in-range, legal hubs that lost the multi-connect cap race
   * (could-but-won't connect). Identical count to `placementPreviewOverflowCount`
   * — the restyle only changes the COLOUR (red → dotted green), not the cap. 0
   * when no preview is up or the in-range legal hubs are at/below the cap.
   */
  placementPreviewDeferredCount = 0;

  /**
   * WS-10 (R2.3) — the world-unit RADIUS of the connection-range ring the LAST
   * `update()` drew around the placement ghost (`ghost edge-to-edge reach` =
   * `min(kind.connectionRange, CONNECTION_MAX_RANGE) + ghostRadius`), or 0 when
   * no preview is up. The renderer-field test hook (the drawn ring isn't
   * headlessly inspectable — same observable pattern as
   * `placementPreviewConnectionCount`); read by the unit lock.
   */
  lastRangeCircleRadius = 0;

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
  /** WS-5 (R2.17) — reused scratch for the 'ok' hubs of the current preview
   *  frame, sorted by edge-distance so the nearest `PLACEMENT_MAX_CONNECTIONS`
   *  draw GREEN and the rest draw RED overflow. Parallel arrays (node refs +
   *  their distances) so the in-place insertion sort never allocates (#14). */
  private readonly _okHubScratch: GridNode[] = [];
  private readonly _okDistScratch: number[] = [];

  /** R2.2 — reused per-edge connector-visual scratch (base line + comet params),
   *  written in place every edge every frame (invariant #14). */
  private readonly _edgeVisual: ConnectorVisual = {
    color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0,
    pulseActive: false, pulseT: 0, pulseColor: 0, pulseAlpha: 0, pulseWidth: 0,
  };
  /** R2.2 — reused travelling-comet segment scratch (connector pulse + shield
   *  shimmer both write it). */
  private readonly _comet: CometSegment = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** R2.19 — reused shield-wall visual scratch, written per wall per frame (#14). */
  private readonly _shieldVisual: ShieldWallVisual = {
    active: false, glowColor: 0, glowAlpha: 0, glowWidth: 0,
    railColor: 0, railAlpha: 0, railWidth: 0, halfThickness: 0,
    shimmerT: 0, shimmerColor: 0, shimmerAlpha: 0, shimmerWidth: 0,
  };

  /** Redraw the web for this frame. `scale` is the viewport zoom. */
  update(mirror: RenderMirror, scale: number, nowMs: number): void {
    const g = this.gfx;
    g.clear();
    const structures = mirror.structures;
    const swarm = mirror.swarm;
    // The preview can run even with zero PLACED structures (the ghost still
    // wants to know there's nothing to connect to), but it needs the swarm to
    // resolve poses + asteroids. Reset the counts up front so a frame with no
    // preview always publishes 0.
    this.placementPreviewConnectionCount = 0;
    this.placementPreviewOverflowCount = 0;
    this.placementPreviewSelectedCount = 0;
    this.placementPreviewDeferredCount = 0;
    this.lastRangeCircleRadius = 0;
    if (swarm) this.drawPlacementPreview(mirror, swarm, scale);
    if (!structures || !swarm || structures.size === 0) {
      if (this._buildAnchors.size > 0) this._buildAnchors.clear();
      return;
    }
    const flashes = mirror.gridFlashes;
    const flowSrc = mirror.gridFlowSrc;

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
        // id < otherId here, so the packed key's lo = id (the (ax,ay) end).
        const key = id * 65536 + otherId;
        const flashUntil = flashes ? (flashes.get(key) ?? 0) : 0;
        const src = flowSrc ? flowSrc.get(key) : undefined;
        // R2.2 — desync edges by source id so the grid reads as organic flow,
        // not a global strobe (a coherent hop-distance wavefront is future polish).
        const phaseOffset = src !== undefined ? (src & 7) / 8 : 0;
        const v = connectorVisualInto(this._edgeVisual, flashUntil, nowMs, scale, phaseOffset);
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
        // R2.2 — the travelling-comet flow pulse (always runs source→dest).
        // sourceIsLo ⇒ the flow source is the lower-id endpoint (id = the (ax,ay)
        // end); default forward when the direction wasn't recorded.
        if (v.pulseActive && (v.pulseAlpha ?? 0) > 0) {
          const sourceIsLo = src === undefined || src === id;
          const c = cometSegment(this._comet, v.pulseT ?? 0, sourceIsLo, ax, ay, bx, by, scale);
          g.moveTo(c.x0, c.y0);
          g.lineTo(c.x1, c.y1);
          g.stroke({ color: v.pulseColor ?? 0, alpha: v.pulseAlpha ?? 0, width: v.pulseWidth ?? 0 });
        }
      }

      // Shield-fence — the blocking shield-wall span between this pylon and its
      // pair. Drawn ONCE from the lower-entityId side (both pylons carry the
      // reciprocal `shieldWallTo`). R2.19: a distinct cyan-white energy BARRIER
      // — a glow field + two parallel rails (the band slab) + a sweeping shimmer
      // — so it never reads as a connector link. Down = the dim red flicker.
      if (st.shieldWallTo !== undefined && id < st.shieldWallTo) {
        const wb = swarm.get(st.shieldWallTo);
        if (wb) {
          const wx = wb.x;
          const wy = -wb.y;
          const sv = shieldWallVisualParams(this._shieldVisual, st.wallActive === true, nowMs, scale);
          // Glow field down the centreline (drawn first, behind the rails).
          if (sv.glowAlpha > 0) {
            g.moveTo(ax, ay); g.lineTo(wx, wy);
            g.stroke({ color: sv.glowColor, alpha: sv.glowAlpha, width: sv.glowWidth });
          }
          if (sv.halfThickness > 0) {
            // Band: two rails offset by ±halfThickness along the span NORMAL.
            const dx = wx - ax;
            const dy = wy - ay;
            const len = Math.hypot(dx, dy);
            if (len > 0.001) {
              const nx = (-dy / len) * sv.halfThickness;
              const ny = (dx / len) * sv.halfThickness;
              g.moveTo(ax + nx, ay + ny); g.lineTo(wx + nx, wy + ny);
              g.stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth });
              g.moveTo(ax - nx, ay - ny); g.lineTo(wx - nx, wy - ny);
              g.stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth });
            }
            // Travelling shimmer along the centreline (the "live energy" sweep).
            if (sv.shimmerAlpha > 0) {
              const c = cometSegment(this._comet, sv.shimmerT, true, ax, ay, wx, wy, scale);
              g.moveTo(c.x0, c.y0); g.lineTo(c.x1, c.y1);
              g.stroke({ color: sv.shimmerColor, alpha: sv.shimmerAlpha, width: sv.shimmerWidth });
            }
          } else {
            // Down: a single dim flickering red line ships can pass.
            g.moveTo(ax, ay); g.lineTo(wx, wy);
            g.stroke({ color: sv.railColor, alpha: sv.railAlpha, width: sv.railWidth });
          }
        }
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
      // Issue 1: the fill is interpolated LINEARLY between the 1 Hz authoritative
      // `buildPct` steps using the server `etaMs`, so it builds smoothly rather
      // than jumping each pulse.
      if (!st.built) {
        const shownPct = this.displayedBuildPct(id, st.buildPct, st.etaMs ?? null, nowMs);
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * Math.min(1, Math.max(0, shownPct)), barH);
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
      } else if (st.storedPowerMax !== undefined && st.storedPowerMax > 0) {
        // WS-9 (R2.12) — a Battery's always-on CHARGE bar above the built body
        // (amber, matching the panel CHRG colour). Immediate-mode like the fill-bar.
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        const frac = Math.min(1, Math.max(0, (st.storedPower ?? 0) / st.storedPowerMax));
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * frac, barH);
        g.fill({ color: 0xcc8844, alpha: 0.9 });
      }

      // WS-9 (R2.20) — out-of-power indicator: a red "disabled" ring (circle +
      // slash) above a BUILT but UNPOWERED structure. Immediate-mode, zero-alloc.
      if (st.built && st.powered === false) {
        const r = a.radius;
        const cx = ax;
        const cy = ay - r - 12;
        const ir = Math.max(4, r * 0.22);
        const w = Math.max(1.5 / scale, 2);
        g.circle(cx, cy, ir);
        g.stroke({ color: 0xff4444, width: w, alpha: 0.95 });
        const d = ir * 0.7;
        g.moveTo(cx - d, cy - d);
        g.lineTo(cx + d, cy + d);
        g.stroke({ color: 0xff4444, width: w, alpha: 0.95 });
      }
    }

    // Prune build anchors for structures that have completed or disappeared
    // (tiny set — only live while something is under construction).
    if (this._buildAnchors.size > 0) {
      for (const id of this._buildAnchors.keys()) {
        const s = structures.get(id);
        if (!s || s.built) this._buildAnchors.delete(id);
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
    // Phase-4 C4 — once the player clicks to place, the preview is swapped to a
    // dim `pending:true` ghost (the Issue-7 anti-vanish bridge) held for up to
    // PENDING_PLACEMENT_TIMEOUT_MS. The candidate green/red/overflow web + the
    // range ring are a decision aid for POSITIONING — irrelevant after commit, so
    // collapse them the instant the ghost goes pending ("when you click to place
    // it should remove all but the green"). The real green edge re-appears via the
    // normal placed-structure `connTo` web (update()'s st.connTo loop) once the
    // server echoes the connection. The counts were reset to 0 by the caller, so
    // an early return correctly publishes 0 green / 0 overflow / 0 ring radius.
    if (!preview || preview.pending === true) return;

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
    const localOwner = mirror.localPlayerId;
    let poolIdx = 0;
    if (structures) {
      for (const [id, st] of structures) {
        const entry = swarm.get(id);
        if (!entry) continue;
        // Never preview a would-connect line to ANOTHER player's structure: the
        // grid is per-owner server-side (you can't connect to someone else's
        // base), so a cross-owner structure is skipped entirely from the candidate
        // web — no green, no red overflow, no line of any kind.
        if (st.owner !== undefined && localOwner !== null && st.owner !== localOwner) continue;
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

    const ax = ghostX;
    const ay = -ghostY; // Pixi screen space is Y-down; world is Y-up.

    // WS-10 (R2.3) — the connection-RANGE ring around the ghost: how far this
    // kind can reach. Edge-to-edge reach to a zero-radius partner = the kind's
    // `connectionRange` (capped at the global CONNECTION_MAX_RANGE) + the ghost's
    // own radius (measured centre-out). Drawn FIRST so the preview lines + web
    // overlay it. `this._ghostNode` already carries `radius` + `connectionRange`
    // (populated by `ghostToGridNode`), so no second catalogue lookup. Symmetric
    // circle → the Y-flip on `ay` doesn't affect the radius. Alloc-free immediate
    // mode (one `rangeCircleVisualParams` return per frame, placement-only).
    const ghostRange =
      ghost.connectionRange !== undefined
        ? Math.min(ghost.connectionRange, CONNECTION_MAX_RANGE)
        : CONNECTION_MAX_RANGE;
    const circleR = ghostRange + ghost.radius;
    this.lastRangeCircleRadius = circleR;
    const rc = rangeCircleVisualParams(scale);
    this.gfx.circle(ax, ay, circleR);
    this.gfx.stroke({ color: rc.color, alpha: rc.alpha, width: rc.width });

    // WS-5 (R2.17) — gather the 'ok' (would-connect) hubs into scratch so we can
    // sort them by distance and split GREEN (nearest, within the cap) vs RED
    // overflow (past the cap). 'blocked' hubs draw immediately (class is fixed);
    // everything else is skipped.
    const okHubs = this._okHubScratch;
    const okDists = this._okDistScratch;
    okHubs.length = 0;
    okDists.length = 0;
    for (const node of nodes.values()) {
      const res = canConnect(ghost, node, adjacency, nodes, obstacles);
      if (res.ok) {
        okHubs.push(node);
        okDists.push(edgeDistance(ghost, node));
      } else if (res.reason === 'blocked') {
        this.drawPreviewSegment(ax, ay, node, 'blocked', scale);
      }
      // else out-of-range / hub-required / full / self / duplicate → not drawn.
    }

    // Sort ok-hubs nearest-first, ties broken by id (matches the server's
    // deterministic multi-connect order). In-place insertion sort over the
    // parallel node+distance scratch — no per-frame allocation (#14).
    for (let i = 1; i < okHubs.length; i++) {
      // Indices are provably in-bounds (i < length); `!` quiets noUncheckedIndexedAccess.
      const hn = okHubs[i]!;
      const hd = okDists[i]!;
      let j = i - 1;
      while (j >= 0 && (okDists[j]! > hd || (okDists[j]! === hd && okHubs[j]!.id > hn.id))) {
        okHubs[j + 1] = okHubs[j]!;
        okDists[j + 1] = okDists[j]!;
        j--;
      }
      okHubs[j + 1] = hn;
      okDists[j + 1] = hd;
    }

    // P3.7 — GREEN marks ONLY the links that will ACTUALLY form on confirm.
    // `autoConnectStructure` caps a placed structure at its OWN `maxConnections`
    // (1 for a leaf) AS WELL AS the global PLACEMENT_MAX_CONNECTIONS, so the
    // preview must too — otherwise a leaf shows N green lines but connects to
    // just one ("shows 4 connections and then only connect to 1"). The nearest
    // `min(ghost.maxConnections, cap)` draw GREEN; the rest are legal + in range
    // but past the cap → RED overflow (won't link).
    const greenCount = Math.min(okHubs.length, ghost.maxConnections, PLACEMENT_MAX_CONNECTIONS);
    for (let i = 0; i < okHubs.length; i++) {
      // WS-D (#6) restyle: the chosen (within-cap) hubs draw SOLID green
      // ('selected' = the ones that WILL connect); the over-cap remainder draws
      // DOTTED green ('deferred' = could-but-won't), NOT the old red overflow.
      this.drawPreviewSegment(ax, ay, okHubs[i]!, i < greenCount ? 'selected' : 'deferred', scale);
    }
    const deferredCount = okHubs.length - greenCount;
    this.placementPreviewConnectionCount = greenCount;
    this.placementPreviewSelectedCount = greenCount;
    this.placementPreviewOverflowCount = deferredCount;
    this.placementPreviewDeferredCount = deferredCount;
  }

  /** Draw ONE placement-preview segment (ghost → hub) for the given outcome
   *  class (glow underlay first, then the core line — same layering as the web).
   */
  private drawPreviewSegment(
    ax: number,
    ay: number,
    node: GridNode,
    lineKind: PreviewLineKind,
    scale: number,
  ): void {
    const v = previewLineVisualParams(lineKind, scale);
    const g = this.gfx;
    const bx = node.x;
    const by = -node.y; // Pixi screen space is Y-down; world is Y-up.
    if (v.glowAlpha > 0) {
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke({ color: v.color, alpha: v.glowAlpha, width: v.glowWidth });
    }
    // WS-D (#6) — a 'deferred' line is DOTTED: Pixi v8 has no native dash, so
    // walk the segment emitting short `on`-length dashes separated by `off`-length
    // gaps. Alloc-free (scalar march; runs every frame during build mode, #14).
    if (v.dash && v.dash.on > 0) {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        const ux = dx / len;
        const uy = dy / len;
        const period = v.dash.on + v.dash.off;
        let t = 0;
        while (t < len) {
          const segEnd = Math.min(t + v.dash.on, len);
          g.moveTo(ax + ux * t, ay + uy * t);
          g.lineTo(ax + ux * segEnd, ay + uy * segEnd);
          g.stroke({ color: v.color, alpha: v.alpha, width: v.width });
          t += period;
        }
      }
      return;
    }
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke({ color: v.color, alpha: v.alpha, width: v.width });
  }

  /** Item C — override the ghost world position (pointer-chosen point) so the
   *  preview lines emanate from where the ghost is actually drawn. `null`
   *  reverts to the preview pose. Set by `PixiRenderer.update` before
   *  `connectorRenderer.update(...)`. */
  ghostWorldX: number | null = null;
  ghostWorldY: number | null = null;

  /** Phase-1 issue 1 — per-blueprint build-bar interpolation anchors, keyed by
   *  entityId. The server's `buildPct` arrives in 1 Hz steps; we re-anchor on
   *  each value change and ramp LINEARLY between via `interpBuildPct` so the bar
   *  fills smoothly instead of jumping. Tiny (only structures under
   *  construction), pruned when a structure completes / disappears. */
  private readonly _buildAnchors = new Map<number, { pct: number; atMs: number; etaMs: number | null }>();

  /** Resolve the smoothly-interpolated build fraction for blueprint `id`,
   *  re-anchoring when the authoritative `buildPct` changes. */
  private displayedBuildPct(id: number, authoritativePct: number, etaMs: number | null, nowMs: number): number {
    let anchor = this._buildAnchors.get(id);
    if (!anchor || anchor.pct !== authoritativePct) {
      anchor = { pct: authoritativePct, atMs: nowMs, etaMs };
      this._buildAnchors.set(id, anchor);
    }
    return interpBuildPct(anchor.pct, anchor.etaMs, nowMs - anchor.atMs);
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
