/**
 * Server → client ship status: click-to-inspect live stats, the owner's fleet
 * status stream, level-ups, upgrade/respec acks and mount activations.
 * zod-validated (#3/#4); purity-clean — discrete UI values only, no positions
 * reach Zustand (#2).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { ServerMessageSchemas } from '@shared-types/messages';
import { useUIStore } from '../../state/store';
import { applySelectionStats } from '../selectionStats.js';
import { ingestFleetStatus } from '../../fleet/fleetStatusIngest.js';

/** What the ship-status handlers touch: the mirror (local ids + the level-up queue). */
export interface ShipStatusHandlerCtx {
  readonly mirror: RenderMirror;
}

export function registerShipStatusHandlers(room: Room, ctx: ShipStatusHandlerCtx): void {
  const mirror = ctx.mirror;

  /**
   * Phase 4 WS-B1 — a ship instance just levelled up. The PUBLIC badge for ALL
   * ships refreshes from the next snapshot's `states[].level` (applyShipLevels);
   * this only pops the OWNER-facing screenspace level-up icon for the LOCAL
   * player's own hull (resolved via `localShipInstanceId`). Remote level-ups
   * just refresh their badge — no icon for other players. Discrete + low-
   * frequency (a kill threshold), so the single pooled-array push is off the
   * hot path (mirrors `pendingEffectTriggers` pushes from `handleDamage`).
   */
  const handleShipLevelUp = (shipInstanceId: string, newLevel: number): void => {
    const localShipInstanceId = mirror.localShipInstanceId;
    const localPlayerId = mirror.localPlayerId;
    if (localShipInstanceId == null || localPlayerId == null) return;
    if (shipInstanceId !== localShipInstanceId) return; // owner-facing icon only
    // Pooled one-frame trigger — drained by the renderer, cleared in
    // consumeOneFrameTriggers. Keyed by playerId so the renderer resolves it to
    // the local ship's (playerId-keyed) mirror pose for the screenspace anchor.
    const queue = mirror.pendingLevelUps;
    if (queue) queue.push({ playerId: localPlayerId, newLevel });
    // Discrete Zustand seam for the upgrade modal (WS-B2 wires the modal open;
    // here we surface "the local player just hit level N" as a discrete scalar —
    // purity-clean, Invariant #2). A no-op until WS-B2 reads it.
    useUIStore.getState().setPendingLevelUp(newLevel);
  };

  // Click-to-inspect (structures follow-up Item B5) — live stats for the
  // locally-selected entity arrive at ~5 Hz. Defensive zod parse (invariant
  // #3); on success mutate the `selectionStats` module singleton in place (NO
  // Zustand write — the panel polls the singleton ~1 Hz, avoiding 5 Hz React
  // re-renders).
  room.onMessage('entity_stats', (raw: unknown) => {
    const parsed = ServerMessageSchemas.entity_stats.safeParse(raw);
    if (!parsed.success) return;
    applySelectionStats(parsed.data);
  });
  // RTS slice 7 — the owner-only fleet status stream (~2 Hz, the whole owned
  // fleet each time) → the `fleet/fleetStatus` singleton the panel polls.
  room.onMessage('fleet_status', (raw: unknown) => {
    ingestFleetStatus(raw);
  });

  // Phase 4 WS-B1 — a ship instance levelled up (public, D13). Defensive zod
  // parse (invariant #3/#4 — crosses the trust boundary). The badge refresh
  // for ALL ships rides the next snapshot's states[].level; THIS handler pops
  // the owner-facing screenspace level-up icon for the LOCAL player's hull.
  room.onMessage('ship_level_up', (raw: unknown) => {
    const parsed = ServerMessageSchemas.ship_level_up.safeParse(raw);
    if (!parsed.success) return;
    handleShipLevelUp(parsed.data.shipInstanceId, parsed.data.newLevel);
  });

  // Phase 4 WS-B2 — the server accepted + persisted a stat allocation / respec.
  // Publish a discrete Zustand ack so the upgrade modal closes + the roster
  // refreshes; the physics multipliers re-anchor off the snapshot slice, not
  // this echo (so this is UI-confirmation only). Defensive zod parse.
  room.onMessage('ship_upgrade_applied', (raw: unknown) => {
    const parsed = ServerMessageSchemas.ship_upgrade_applied.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().setUpgradeAck({
      shipInstanceId: parsed.data.shipInstanceId,
      alloc: parsed.data.alloc,
      spent: parsed.data.spent,
      budget: parsed.data.budget,
    });
  });

  // Phase 4 WS-B3 — the server accepted + persisted a dynamic-mount activation.
  // Patch the Zustand roster entry's `mounts` so the upgrade modal's activated
  // set updates immediately (the roster poll would also catch it within ~3 s,
  // but the patch makes the modal feel responsive). The IN-WORLD render +
  // fire come off the snapshot `states[].mounts` slice (the authority), not
  // this echo. Defensive zod parse.
  room.onMessage('mount_activated', (raw: unknown) => {
    const parsed = ServerMessageSchemas.mount_activated.safeParse(raw);
    if (!parsed.success) return;
    const evt = parsed.data;
    const store = useUIStore.getState();
    const patched = store.shipRoster.map((r) =>
      r.shipId === evt.shipInstanceId
        ? { ...r, mounts: evt.mounts.map((m) => ({ slotId: m.slotId, weaponId: m.weaponId })) }
        : r,
    );
    store.setShipRoster(patched);
  });
}
