/**
 * Per-tick AI fan-out — rebuilds the per-player view, ticks the AI
 * controller, drains queued fire requests. Lifted out of
 * `SectorRoom.update()`.
 *
 * Called AT THE END of update() so impulses posted now reach the
 * worker BEFORE the next SAB read. Defect 1 (5c-stabilise plan): if
 * AI ticks before the encoder reads SAB in the same update() call,
 * the intent is still in-flight and the encoder broadcasts a pose
 * that doesn't include this tick's impulse — observed as drone
 * stutter.
 *
 * View is rebuilt in-place into the persistent scratch array each
 * tick to avoid alloc. Phase 6c — drones only see active hulls;
 * lingering hulls (isActive=false during the 15-min disconnect
 * window) are skipped here so the AI never targets them. Matching
 * client-side gate lives in ColyseusClient's AI view construction
 * (Input Symmetry Rule, `src/core/CLAUDE.md`). Lock:
 * `tests/integration/sectorRoom/droneTargetActiveOnly.test.ts`.
 */

import type { AiController } from '../../core/ai/AiController.js';
import type { AiPlayerView, AiStructureView, AiEntity } from '../../core/contracts/IAiBehaviour.js';
import type { PoseRecord } from './SabPoseMirror.js';

export interface AiFireRequest {
  shooterId: string;
  dirX: number;
  dirY: number;
  tick: number;
}

export interface AiTickCtx {
  aiController: AiController;
  serverTick: number;
  playerToSlot: Map<string, number>;
  getActiveShip: (playerId: string) => { alive: boolean; isActive: boolean; health: number; maxHealth: number } | undefined;
  shipPoseCache: Map<string, PoseRecord>;
  aiPlayerScratch: AiPlayerView[];
  /** Wave-system Phase 2 — reused per-tick buffer for the faction-filtered
   *  structure targets fed to the drone AI. Filled by `fillStructureTargets`. */
  aiStructureScratch: AiStructureView[];
  /** Wave-system Phase 2 — clear + repopulate `aiStructureScratch` with this
   *  sector's hostile (under-wave / member-attacked) constructed structures.
   *  Built ONCE per tick here (not per drone — #14). Omitted ⇒ no structure
   *  targeting (byte-identical to pre-wave). */
  fillStructureTargets?: (out: AiStructureView[]) => void;
  swarmEntitySnapshot: (id: string) => AiEntity | null;
  handleAiFire: (shooterId: string, dirX: number, dirY: number, tick: number) => void;
  /** Phase-time callback — fires for 'aiTick' after the controller tick
   *  and 'aiFire' after the fire pipeline drains. */
  phaseTime: (key: string) => void;
}

export function runAiTick(ctx: AiTickCtx): void {
  if (ctx.aiController.size() === 0) return;
  ctx.aiPlayerScratch.length = 0;
  for (const [pid] of ctx.playerToSlot) {
    const ship = ctx.getActiveShip(pid);
    if (!ship?.alive) continue;
    if (!ship.isActive) continue;
    const pose = ctx.shipPoseCache.get(pid);
    if (!pose) continue;
    ctx.aiPlayerScratch.push({
      id: pid, x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy,
      health: ship.health, maxHealth: ship.maxHealth,
    });
  }
  // Build the faction-filtered structure target list ONCE per tick (shared by
  // every drone via the AiWorldView — never per-drone, #14). Empty/absent ⇒
  // drones target players only.
  let structures: AiStructureView[] | undefined;
  if (ctx.fillStructureTargets) {
    ctx.aiStructureScratch.length = 0;
    ctx.fillStructureTargets(ctx.aiStructureScratch);
    if (ctx.aiStructureScratch.length > 0) structures = ctx.aiStructureScratch;
  }
  ctx.aiController.tick(
    ctx.serverTick, 1 / 60, ctx.aiPlayerScratch, ctx.swarmEntitySnapshot, structures,
  );
  ctx.phaseTime('aiTick');

  const fires = ctx.aiController.drainFireRequests();
  for (const f of fires) ctx.handleAiFire(f.shooterId, f.dirX, f.dirY, f.tick);
  ctx.phaseTime('aiFire');
}
