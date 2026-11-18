/**
 * Server → client message handlers, one file per feature. `connect()` calls
 * `registerClientHandlers` once per bound room; a new handler file adds its
 * ctx to `ClientHandlerCtx` and one call below.
 */
import type { Room } from 'colyseus.js';
import { registerCombatHandlers, type CombatHandlerCtx } from './combatHandlers.js';
import { registerDiagnosticHandlers } from './diagnosticHandlers.js';
import { registerFieldHandlers, type FieldHandlerCtx } from './fieldHandlers.js';
import { registerGridPulseHandlers, type GridPulseHandlerCtx } from './gridPulseHandlers.js';
import { registerImpactFxHandlers, type ImpactFxHandlerCtx } from './impactFxHandlers.js';
import { registerMissileHandlers, type MissileHandlerCtx } from './missileHandlers.js';
import { registerShellHandlers, type ShellHandlerCtx } from './shellHandlers.js';
import { registerShipStatusHandlers, type ShipStatusHandlerCtx } from './shipStatusHandlers.js';
import { registerStructurePanelHandlers, type StructurePanelHandlerCtx } from './structurePanelHandlers.js';
import { registerToastHandlers, type ToastHandlerCtx } from './toastHandlers.js';
import { registerTransitHandlers, type TransitHandlerCtx } from './transitHandlers.js';
import { registerWaveHandlers, type WaveHandlerCtx } from './waveHandlers.js';
import { registerWebrtcSignallingHandlers, type WebrtcSignallingHandlerCtx } from '../dataChannelTransport.js';

export type ClientHandlerCtx = CombatHandlerCtx &
  FieldHandlerCtx &
  GridPulseHandlerCtx &
  ImpactFxHandlerCtx &
  MissileHandlerCtx &
  ShellHandlerCtx &
  ShipStatusHandlerCtx &
  StructurePanelHandlerCtx &
  ToastHandlerCtx &
  TransitHandlerCtx &
  WaveHandlerCtx &
  WebrtcSignallingHandlerCtx;

export function registerClientHandlers(room: Room, ctx: ClientHandlerCtx): void {
  registerShipStatusHandlers(room, ctx);
  registerMissileHandlers(room, ctx);
  registerImpactFxHandlers(room, ctx);
  registerToastHandlers(room, ctx);
  registerWaveHandlers(room, ctx);
  registerStructurePanelHandlers(room, ctx);
  registerFieldHandlers(room, ctx);
  registerShellHandlers(room, ctx);
  registerTransitHandlers(room, ctx);
  registerCombatHandlers(room, ctx);
  registerGridPulseHandlers(room, ctx);
  registerDiagnosticHandlers(room);
  registerWebrtcSignallingHandlers(room, ctx);
}
