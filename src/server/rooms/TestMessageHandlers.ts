/**
 * Test-only message handlers (`test_aggro`, `test_reload_turrets`,
 * `test_kill_capitals`, `test_fleet_warp`, `test_tractor`): cues integration and E2E tests
 * send to skip a long setup. Every handler is gated on the room's testMode
 * (or `EQX_ALLOW_DEV_OVERRIDES=1`); a production client's message is ignored.
 *
 * Extracted from `SectorRoom.onCreate` (review 2026-11-14 §8, slice D1) in the
 * `RespawnHandler` class form: `onCreate` constructs it with exactly the
 * dependencies it needs and registers each method with `onMessage`.
 */

import type { Client } from 'colyseus';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import {
  TestAggroSchema,
  TestReloadTurretsSchema,
  TestKillCapitalsSchema,
  TestFleetWarpSchema,
  TestTractorSchema,
} from '../../shared-types/messages.js';
import { isCapitalKindId } from '../../core/combat/capitalHits.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { MalformedMessageTracker } from './MalformedMessageTracker.js';

export interface TestMessageHandlersDeps {
  testMode: boolean;
  allowDevOverrides: boolean;
  sabF32: Float32Array;
  sessionToPlayer: Map<string, string>;
  swarmRegistry: SwarmEntityRegistry;
  malformed: MalformedMessageTracker;
  markAllDronesHostileTo: (playerId: string) => void;
  reloadAllTurrets: () => void;
  applyDamage: (targetId: string, shooterId: string, damage: number, hitX: number, hitY: number) => void;
  warpBot: (botId: string, x: number, y: number) => void;
  setBotMoveTarget: (botId: string, x: number, y: number) => void;
  /** Hold a tractor from the player's first mount on swarm entity `entityId`
   *  for `ticks` (`ForceFieldSubsystem.renewTractor`). */
  testTractor: (playerId: string, entityId: number, ticks: number) => void;
}

export class TestMessageHandlers {
  constructor(private readonly deps: TestMessageHandlersDeps) {}

  /** `test_aggro`: every drone turns hostile to the sender. */
  aggro(client: Client, raw: unknown): void {
    const d = this.deps;
    if (!(d.testMode || d.allowDevOverrides)) return;
    const playerId = d.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;
    if (!TestAggroSchema.safeParse(raw).success) {
      d.malformed.record(client.sessionId, 'test_aggro');
      return;
    }
    d.markAllDronesHostileTo(playerId);
  }

  /** Coastal defences — `test_reload_turrets`: reload every structure gun now. */
  reloadTurrets(client: Client, raw: unknown): void {
    const d = this.deps;
    if (!(d.testMode || d.allowDevOverrides)) return;
    if (!TestReloadTurretsSchema.safeParse(raw).success) {
      d.malformed.record(client.sessionId, 'test_reload_turrets');
      return;
    }
    d.reloadAllTurrets();
  }

  /** Capital destruction S2b — `test_kill_capitals`: every capital NPC takes a
   *  lethal hit now (at its own pose; the kill point lands on the hull edge),
   *  so an E2E sees its wreck without a long gun duel. */
  killCapitals(client: Client, raw: unknown): void {
    const d = this.deps;
    if (!(d.testMode || d.allowDevOverrides)) return;
    if (!TestKillCapitalsSchema.safeParse(raw).success) {
      d.malformed.record(client.sessionId, 'test_kill_capitals');
      return;
    }
    for (const rec of [...d.swarmRegistry.all()]) { // TODO: alloc-debt (test cue only)
      if (rec.kind !== SWARM_KIND_DRONE || !isCapitalKindId(rec.shipKind)) continue;
      const b = slotBase(rec.slot);
      const x = d.sabF32[b + SLOT_X_OFF]!, y = d.sabF32[b + SLOT_Y_OFF]!;
      // A shield takes the first hit whole: hit again until the hull goes.
      for (let i = 0; i < 4 && d.swarmRegistry.get(rec.id) === rec; i++) d.applyDamage(rec.id, 'test-kill', 1e9, x, y);
    }
  }

  /** W2c showcase — `test_fleet_warp`: warp the room's ships to (x, y), keeping
   *  the formation (offsets from the biggest ship, the flagship). */
  fleetWarp(client: Client, raw: unknown): void {
    const d = this.deps;
    if (!(d.testMode || d.allowDevOverrides)) return;
    const parsed = TestFleetWarpSchema.safeParse(raw);
    if (!parsed.success) {
      d.malformed.record(client.sessionId, 'test_fleet_warp');
      return;
    }
    let lead: { id: string; slot: number; radius: number } | null = null;
    for (const rec of d.swarmRegistry.all()) if (rec.kind === 1 && (lead === null || rec.radius > lead.radius)) lead = rec;
    if (lead === null) return;
    const lb = slotBase(lead.slot);
    const lx = d.sabF32[lb + SLOT_X_OFF]!, ly = d.sabF32[lb + SLOT_Y_OFF]!;
    for (const rec of [...d.swarmRegistry.all()]) { // TODO: alloc-debt (test cue only)
      if (rec.kind !== 1) continue;
      const b = slotBase(rec.slot);
      const tx = parsed.data.x + d.sabF32[b + SLOT_X_OFF]! - lx, ty = parsed.data.y + d.sabF32[b + SLOT_Y_OFF]! - ly;
      d.warpBot(rec.id, tx, ty);
      d.setBotMoveTarget(rec.id, tx, ty); // hold there after the drop
    }
  }

  /** Salvage plan PR 11b showcase — `test_tractor`: the sender's first mount
   *  holds a tractor beam on a swarm entity, as if it carried the tractor
   *  (no ship kind does until the barge). */
  tractor(client: Client, raw: unknown): void {
    const d = this.deps;
    if (!(d.testMode || d.allowDevOverrides)) return;
    const playerId = d.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;
    const parsed = TestTractorSchema.safeParse(raw);
    if (!parsed.success) {
      d.malformed.record(client.sessionId, 'test_tractor');
      return;
    }
    d.testTractor(playerId, parsed.data.target, parsed.data.ticks);
  }
}
