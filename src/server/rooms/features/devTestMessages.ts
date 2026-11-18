/**
 * Test-only client messages (`test_tractor`, `test_aggro`,
 * `test_reload_turrets`, `test_kill_capitals`, `test_fleet_warp`): cues
 * integration and E2E tests send to skip a long setup. Each handler lives on
 * `TestMessageHandlers`, which gates it on the room's testMode (or
 * `EQX_ALLOW_DEV_OVERRIDES=1`) before it parses the payload.
 */
import type { Client } from 'colyseus';
import { TestMessageHandlers, type TestMessageHandlersDeps } from '../TestMessageHandlers.js';
import type { RoomFeature } from './parsedMessage.js';

/** What the test handlers need from the room. */
export interface DevTestMessageHost {
  onMessage(type: string, handler: (client: Client, raw: unknown) => void): void;
  devTest: TestMessageHandlersDeps;
}

export function registerDevTestMessages(h: DevTestMessageHost): RoomFeature {
  const testHandlers = new TestMessageHandlers(h.devTest);
  h.onMessage('test_tractor', (client: Client, raw: unknown) => testHandlers.tractor(client, raw));
  h.onMessage('test_aggro', (client: Client, raw: unknown) => testHandlers.aggro(client, raw));
  h.onMessage('test_reload_turrets', (client: Client, raw: unknown) => testHandlers.reloadTurrets(client, raw));
  h.onMessage('test_kill_capitals', (client: Client, raw: unknown) => testHandlers.killCapitals(client, raw));
  h.onMessage('test_fleet_warp', (client: Client, raw: unknown) => testHandlers.fleetWarp(client, raw));
  return {};
}
