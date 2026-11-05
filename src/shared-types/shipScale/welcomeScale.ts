/**
 * The ship scale on the join welcome — both sides of the contract in one place
 * (invariant #15). The server stamps its scale onto every welcome; the client
 * compares it with its own (a catalogue built at another scale desyncs physics
 * and hits). Pure: no imports beyond the config.
 */
import { SHIP_KIND_SCALE, SHIP_SCALE, SHIP_TUNING, type ShipTuningProfile } from './config.js';

export interface WelcomeScaleFields {
  shipScale?: number;
  shipTuning?: ShipTuningProfile;
  shipKindScale?: string;
}

/** Server side: stamp this process's ship scale onto EVERY welcome. It used
 *  to be left off at the default, which the client reads as 1× / A — wrong
 *  once the default became 2× B (capture v5ga3m). */
export function stampShipScale<W extends WelcomeScaleFields>(w: W): W {
  return { ...w, shipScale: SHIP_SCALE, shipTuning: SHIP_TUNING, ...(SHIP_KIND_SCALE ? { shipKindScale: SHIP_KIND_SCALE } : {}) };
}

// A type alias (not an interface) so it can be logged as a plain record.
export type ShipScaleMismatch = {
  server: number; client: number;
  serverTuning: ShipTuningProfile; clientTuning: ShipTuningProfile;
  serverKinds: string; clientKinds: string;
  fix: string;
};

/** Client side: how a welcome's scale differs from this client's, or null. */
export function shipScaleMismatch(msg: WelcomeScaleFields): ShipScaleMismatch | null {
  const server = msg.shipScale ?? 1;
  const serverTuning = msg.shipTuning ?? 'A';
  const serverKinds = msg.shipKindScale ?? '';
  if (server === SHIP_SCALE && serverTuning === SHIP_TUNING && serverKinds === SHIP_KIND_SCALE) return null;
  return {
    server, client: SHIP_SCALE, serverTuning, clientTuning: SHIP_TUNING,
    serverKinds, clientKinds: SHIP_KIND_SCALE,
    fix: `?shipScale=${server}&shipTuning=${serverTuning}`,
  };
}
