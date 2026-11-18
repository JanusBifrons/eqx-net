/**
 * Server → client message handlers, one file per feature. `connect()` calls
 * `registerClientHandlers` once per bound room; a new handler file adds its
 * ctx to `ClientHandlerCtx` and one call below.
 */
import type { Room } from 'colyseus.js';
import { registerImpactFxHandlers, type ImpactFxHandlerCtx } from './impactFxHandlers.js';
import { registerMissileHandlers, type MissileHandlerCtx } from './missileHandlers.js';
import { registerStructurePanelHandlers, type StructurePanelHandlerCtx } from './structurePanelHandlers.js';
import { registerToastHandlers, type ToastHandlerCtx } from './toastHandlers.js';
import { registerWaveHandlers, type WaveHandlerCtx } from './waveHandlers.js';

export type ClientHandlerCtx = ImpactFxHandlerCtx &
  MissileHandlerCtx &
  StructurePanelHandlerCtx &
  ToastHandlerCtx &
  WaveHandlerCtx;

export function registerClientHandlers(room: Room, ctx: ClientHandlerCtx): void {
  registerMissileHandlers(room, ctx);
  registerImpactFxHandlers(room, ctx);
  registerToastHandlers(room, ctx);
  registerWaveHandlers(room, ctx);
  registerStructurePanelHandlers(room, ctx);
}
