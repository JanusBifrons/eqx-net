/**
 * Module-level accessor for the live ColyseusGameClient instance.
 *
 * App.tsx is the only writer (calls `setGameClient` once after constructing
 * the client). React components that need infrequent, low-frequency reads
 * from the render mirror — e.g. the Galaxy tab's 5-second arrival snapshot —
 * call `getGameClient()` and read `c.mirror` directly.
 *
 * This is NOT a substitute for prop drilling per-frame data. Components
 * that update at frame rate must continue to read mirror state inside the
 * Pixi loop (not via React subscriptions), per `src/client/CLAUDE.md`
 * Zustand purity rules. Use this only for discrete, low-cadence reads.
 */
import type { ColyseusGameClient } from './ColyseusClient.js';

let instance: ColyseusGameClient | null = null;

export function setGameClient(c: ColyseusGameClient | null): void {
  instance = c;
}

export function getGameClient(): ColyseusGameClient | null {
  return instance;
}
