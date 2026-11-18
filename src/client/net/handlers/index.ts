/**
 * Server → client message handlers, one file per feature. `connect()` calls
 * `registerClientHandlers` once per bound room; a new handler file adds its
 * ctx to `ClientHandlerCtx` and one call below.
 */
import type { Room } from 'colyseus.js';
import { registerImpactFxHandlers, type ImpactFxHandlerCtx } from './impactFxHandlers.js';
import { registerToastHandlers, type ToastHandlerCtx } from './toastHandlers.js';

export type ClientHandlerCtx = ImpactFxHandlerCtx & ToastHandlerCtx;

export function registerClientHandlers(room: Room, ctx: ClientHandlerCtx): void {
  registerImpactFxHandlers(room, ctx);
  registerToastHandlers(room, ctx);
}
