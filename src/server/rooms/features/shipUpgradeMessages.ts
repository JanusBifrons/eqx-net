/**
 * Ship-upgrade client messages — stat allocation + respec (WS-B2), instant
 * repair at your own storage (P1a-2) and latent weapon mounts (WS-B3). Moved
 * verbatim out of `SectorRoom.onCreate`, with `activateMount` (only these
 * handlers used it); `applyShipUpgrade` stays on the room (it rebuilds a
 * lingering wingman's brain) and is reached through the host.
 */
import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { StatAlloc as CoreStatAlloc } from '../../../core/leveling/shipStats.js';
import type { ShipState } from '../schema/SectorState.js';
import { REPAIR_CREDITS_PER_HP, RESPEC_CREDIT_COST, type StorageService } from '../../cargo/StorageService.js';
import { getPlayerShipStore, getWallet } from '../../db/PersistenceWorker.js';
import type { ActivatedMount } from '../../playerShips/PlayerShipStore.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { isLatentSlot } from '../../../shared-types/shipKinds/slots.js';
import { weaponUnlocked } from '../../../shared-types/blueprints.js';
import { ActivateMountSchema, ApplyShipUpgradeSchema, RepairShipSchema, RespecShipSchema } from '../../../shared-types/messages.js';

/** What the handlers need from the room; getters read the live field. */
export interface ShipUpgradeMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  sectorKey(): string | null;
  storage(): Pick<StorageService, 'nearestOwnStorage'>;
  getActiveShip(playerId: string): ShipState | undefined;
  shipPoseCache: Pick<ReadonlyMap<string, ShipPhysicsState>, 'get'>;
  resolveActiveShipKey(playerId: string): string | undefined;
  ship(shipInstanceId: string): ShipState | undefined;
  fittedOf(shipInstanceId: string): readonly string[];
  sendNotice(client: Client, text: string): void;
  applyShipUpgrade(client: Client, playerId: string, shipId: string, alloc: CoreStatAlloc): void;
  logger: Pick<Logger, 'warn'>;
}

export function registerShipUpgradeMessages(h: ShipUpgradeMessageHost): RoomFeature {
  // ── Phase 4 WS-B2 — ship stat upgrades (free allocation + respec) ──────
  // Spend the ship instance's upgrade points (budget = level - 1) across the
  // stat pool, FREELY (re-distribute any way within the budget). Owner-gated +
  // budget-gated server-side; the multipliers are applied at the ONE seam the
  // clamps live (applyShipInput, identical server + client) so prediction
  // stays in lockstep (risk #1).
  parsedMessage(h, 'apply_ship_upgrade', ApplyShipUpgradeSchema, (msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    h.applyShipUpgrade(client, playerId, msg.shipId, msg.alloc as CoreStatAlloc);
  });

  parsedMessage(h, 'respec_ship', RespecShipSchema, (msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    // A respec is a CREDIT SINK: RESPEC_CREDIT_COST from the WALLET (economy
    // v2 — anywhere). Charged only for an OWNED ship with points to refund.
    const row = h.sectorKey() !== null ? getPlayerShipStore().get(msg.shipId) : null;
    if (row === null || row.playerId !== playerId || Object.keys(row.statAlloc).length === 0) return;
    if (!getWallet().debit(playerId, RESPEC_CREDIT_COST, 'respec')) {
      h.sendNotice(client, `Respec costs ${RESPEC_CREDIT_COST} cr — not enough credits`);
      return;
    }
    auditEvent({ event: 'credits_spent', sector: h.sectorKey() ?? undefined, playerId, amount: RESPEC_CREDIT_COST, reason: 'respec' });
    // A respec is "apply the empty allocation" — refund every spent point.
    h.applyShipUpgrade(client, playerId, msg.shipId, {});
  });

  // ── Living World P1a-2 — instant repair at your own storage (credit sink) ──
  // Repairs the sender's ACTIVE hull to full while it sits within
  // DEPOSIT_RANGE of its own operational storage; costs REPAIR_CREDITS_PER_HP
  // per missing hull point from the credits banked in this sector.
  parsedMessage(h, 'repair_ship', RepairShipSchema, (_msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const ship = h.getActiveShip(playerId);
    const pose = h.shipPoseCache.get(playerId);
    if (!ship?.alive || !ship.isActive || !pose) return;
    const missing = ship.maxHealth - ship.health;
    if (missing <= 0) return;
    if (h.storage().nearestOwnStorage(playerId, pose.x, pose.y) === null) {
      h.sendNotice(client, 'Fly to your own Capital or Cargo Bay to repair');
      return;
    }
    const cost = Math.ceil(missing * REPAIR_CREDITS_PER_HP);
    if (!getWallet().debit(playerId, cost, 'repair')) {
      h.sendNotice(client, `Repair costs ${cost} cr — not enough credits`);
      return;
    }
    ship.health = ship.maxHealth;
    auditEvent({ event: 'credits_spent', sector: h.sectorKey() ?? undefined, playerId, amount: cost, reason: 'repair' });
    h.sendNotice(client, `Repaired for ${cost} cr`);
  });

  // ── Phase 4 WS-B3 — dynamic weapon mounts (activate a latent slot) ──────
  // Activate a latent hardpoint on a ship instance + bind a weapon to it.
  // Owner-gated + valid-latent-slot-gated server-side; the activated mount is
  // persisted on the roster, mirrored onto the live ShipState, and fed through
  // the SAME per-instance mount resolver the aim + fire path use, so it fires
  // from the first tick (geometry looked up by slotId on both sides — no wire
  // bump, the scrap-collider trick).
  parsedMessage(h, 'activate_mount', ActivateMountSchema, (msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    activateMount(h, client, playerId, msg.shipId, msg.slotId, msg.weaponId);
  });

  return {};
}

/**
 * Phase 4 WS-B3 — activate a latent weapon mount on a ship instance.
 *
 * Validation order (a foreign / unknown / non-latent / already-active request
 * is a SILENT no-op — no echo, no persistence):
 *   - ownership (`row.playerId === playerId`);
 *   - `slotId` names a real `ShipKind.latentMounts` hardpoint (`isLatentSlot`);
 *   - the slot isn't already activated on this instance.
 * On success: append `{ slotId, weaponId }` to the roster `mounts` (the
 * per-instance source of truth, D8 — switching ships switches the loadout) AND
 * — if this instance is the player's ACTIVE hull in THIS room — mirror it onto
 * `ShipState.mounts` so the SAME-tick aim/fire/snapshot paths pick it up (the
 * per-instance mount resolver reads `ship.mounts`). The `weaponId` is already
 * zod-restricted to the catalogue weapon set. Echoes `mount_activated` with the
 * full activated list so the modal closes + the roster card refreshes. The
 * GEOMETRY is looked up CLIENT-SIDE by `(shipKind, slotId)` — never on the wire.
 */
function activateMount(
  h: ShipUpgradeMessageHost,
  client: Client,
  playerId: string,
  shipId: string,
  slotId: string,
  weaponId: string,
): void {
  const store = getPlayerShipStore();
  const row = store.get(shipId);
  if (row === null || row.playerId !== playerId) return; // foreign / unknown
  const kind = getShipKind(row.kind);
  if (!isLatentSlot(kind, slotId)) {
    h.logger.warn(
      { sessionId: client.sessionId, shipId, slotId },
      'activate_mount: slotId is not a latent hardpoint — dropped',
    );
    return;
  }
  // Already active ⇒ no-op (idempotent; never duplicate the index space).
  if (row.mounts.some((m) => m.slotId === slotId)) return;
  // P5 — a gated weapon (heat-seeker) needs its blueprint fitted to THIS ship.
  if (!weaponUnlocked(weaponId, h.fittedOf(shipId))) return;

  const nextMounts: ActivatedMount[] = [...row.mounts, { slotId, weaponId }];
  // Persist on the roster (the per-instance source of truth, D8).
  store.setProgress(shipId, { mounts: nextMounts });

  // Mirror onto the live ACTIVE hull (if it's piloted in THIS room) so the
  // very next tick's aim + fire + snapshot resolve the new mount.
  const activeShipKey = h.resolveActiveShipKey(playerId);
  if (activeShipKey === shipId) {
    const ship = h.ship(shipId);
    if (ship !== undefined) ship.mounts = nextMounts;
  }

  client.send('mount_activated', {
    type: 'mount_activated',
    shipInstanceId: shipId,
    mounts: nextMounts,
  });
}
