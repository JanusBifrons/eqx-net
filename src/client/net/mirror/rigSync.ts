/**
 * Structure-restyle 2e: the client side of structure rig clips. Moved out of
 * `ColyseusClient` (god-file split): the snapshot-cadence clip sync into
 * predWorld and the per-frame rig clock the renderer poses rigs with.
 */
import type { PhysicsWorld } from '@core/physics/World';
import type { StructureRenderState } from '@core/contracts/IRenderer';
import { DEAD_RECKON_BACK_MS, DEAD_RECKON_CAP_MS } from '../renderTickPhase.js';
import type { MirrorPassCtx } from './mirrorPassCtx.js';

/** Each structure's rig clip (room state, decoded onto its row) into
 *  predWorld, so its solid rig parts replay the server's clip on the same
 *  tick numbering (`stepRigs`). Snapshot cadence. */
export function syncRigClips(
  world: PhysicsWorld | null,
  structures: ReadonlyMap<number, StructureRenderState> | undefined,
  bodyKeys: ReadonlyMap<number, string>,
): void {
  if (!world || !structures) return;
  for (const [id, st] of structures) {
    const key = bodyKeys.get(id);
    if (key === undefined) continue;
    const c = st.rigClip;
    // Idempotent: an unchanged record (or a host with no rig) is a no-op,
    // and a rig attached after the row arrived (streamed in) picks it up.
    if (c === undefined) world.setRigClip(key, null);
    else world.setRigClip(key, c.clipId, c.startTick, c.targetX, c.targetY);
  }
}

/**
 * The rig clip clock (`RenderMirror.rigTick`), in server tick numbering. It
 * is the predicted tick predWorld's `stepRigs` last posed (`inputTick`) plus
 * the game time since that tick was due, in ticks (capped like the local
 * ship's dead-reckon), so the drawn rig and its predWorld colliders follow the
 * same timeline, and a clip that started before this client joined is drawn
 * mid-way (or at its end pose), never restarted. Undefined before welcome.
 *
 * It never runs behind the server clock (the snapshot anchor plus the game
 * time since): with no own ship (command view, Build mode) nothing acks our
 * inputs, so the over-prediction cap holds `inputTick` still, and a clip
 * started after that (e.g. a crane clip in Build mode) would sit before its
 * start tick for good, every part at rest. While piloting, `inputTick` leads the anchor,
 * so the drawn rig still follows predWorld.
 */
export function rigClockTick(ctx: MirrorPassCtx, frameNowMs: number | undefined, welcomed: boolean): number | undefined {
  if (!welcomed) return undefined;
  const gameNow = ctx.gameClock.at(frameNowMs ?? ctx.clock.now());
  // No snapshot anchor yet (welcome only): no server clock to follow.
  const server = ctx.clockAnchorServerTick > 0 ? ctx.clockAnchorServerTick + (gameNow - ctx.clockAnchorPerfNow) / (1000 / 60) : -Infinity;
  if (ctx.lastLocalTickAtMs < 0) return Math.max(ctx.inputTick, server);
  const ms = gameNow - ctx.lastLocalTickAtMs;
  return Math.max(server, ctx.inputTick + Math.max(-DEAD_RECKON_BACK_MS, Math.min(DEAD_RECKON_CAP_MS, ms)) / (1000 / 60));
}
