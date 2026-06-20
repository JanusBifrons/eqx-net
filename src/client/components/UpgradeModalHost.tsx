import { useEffect, useState } from 'react';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { UpgradeModal } from './UpgradeModal';
import type { RosterShipEntry } from './ShipRosterCard';
import type { RosterEntry } from '../state/storeTypes';

/**
 * Mounts the ship-upgrade modal for the LOCAL player and wires it to the live
 * room (Phase 4 WS-B2, plan: effervescent-umbrella).
 *
 * Opens automatically when the local ship LEVELS UP (`pendingLevelUp` — the
 * WS-B1 seam) so the player is invited to spend the freshly-earned point; it can
 * also be opened by the upgrade affordance on the roster. `Apply` / `Respec`
 * route to `getGameClient().applyShipUpgrade / respecShip`; the modal closes on
 * the server's `ship_upgrade_applied` echo (`upgradeAck`).
 *
 * The host owns ONLY discrete UI flags (open/closed) — no spatial state (#2).
 */
export function UpgradeModalHost(): JSX.Element | null {
  const pendingLevelUp = useUIStore((s) => s.pendingLevelUp);
  const setPendingLevelUp = useUIStore((s) => s.setPendingLevelUp);
  const upgradeAck = useUIStore((s) => s.upgradeAck);
  const setUpgradeAck = useUIStore((s) => s.setUpgradeAck);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const shipRoster = useUIStore((s) => s.shipRoster);
  const phase = useUIStore((s) => s.phase);

  const [open, setOpen] = useState(false);

  // A level-up on the local hull invites an upgrade.
  useEffect(() => {
    if (pendingLevelUp !== null && phase === 'game' && localShipInstanceId) {
      setOpen(true);
      setPendingLevelUp(null); // consume the one-shot trigger
    }
  }, [pendingLevelUp, phase, localShipInstanceId, setPendingLevelUp]);

  // Close on the server's apply/respec echo for the local ship.
  useEffect(() => {
    if (upgradeAck && upgradeAck.shipInstanceId === localShipInstanceId) {
      setOpen(false);
      setUpgradeAck(null);
    }
  }, [upgradeAck, localShipInstanceId, setUpgradeAck]);

  if (!open || !localShipInstanceId) return null;

  const rosterShip = shipRoster.find((s) => s.shipId === localShipInstanceId);
  if (rosterShip === undefined) return null;

  const ship = rosterEntryToShip(rosterShip);

  const handleApply = (shipId: string, alloc: Record<string, number>): void => {
    getGameClient()?.applyShipUpgrade(shipId, alloc);
  };
  const handleRespec = (shipId: string): void => {
    getGameClient()?.respecShip(shipId);
  };

  return (
    <UpgradeModal
      ship={ship}
      open={open}
      onClose={() => setOpen(false)}
      onApply={handleApply}
      onRespec={handleRespec}
    />
  );
}

/** Adapt a Zustand `RosterEntry` to the `RosterShipEntry` the modal reads. */
function rosterEntryToShip(r: RosterEntry): RosterShipEntry {
  return {
    shipId: r.shipId,
    kind: r.kind,
    kindVersion: r.kindVersion,
    health: r.health,
    sectorKey: r.sectorKey,
    x: r.x,
    y: r.y,
    isActive: r.isActive,
    activeRoomId: r.activeRoomId ?? null,
    expiresAt: r.expiresAt ?? 0,
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? 0,
    level: r.level,
    statAlloc: r.statAlloc,
  };
}
