/**
 * src/core — the blind simulation zone.
 *
 * Zero DOM, zero Node-only APIs, zero client or server libraries.
 * Only Rapier, eventemitter3, zod (types), and pure TS.
 *
 * See src/core/CLAUDE.md for the full zone contract.
 */

export { Bus } from './events/Bus.js';
export type { BusEventPayloads, BusEventType } from './events/Bus.js';
export { PhysicsWorld } from './physics/World.js';
export type { ShipPhysicsState, ShipInput } from './physics/World.js';
export type { IRenderer, RenderMirror, ShipRenderState } from './contracts/IRenderer.js';
export type { IAudio } from './contracts/IAudio.js';
export type { INetworkSink } from './contracts/INetworkSink.js';
