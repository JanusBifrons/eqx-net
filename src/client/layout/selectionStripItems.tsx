/**
 * The left strip's quick actions for the selection (UI language plan A5 / U3-1):
 * the one-tap actions the old selection card offered, as icons with tooltips.
 * Every action calls the existing handler; an action that can't work is hidden,
 * never shown and then refused.
 *
 * - Target (`fc-target`): lock / cancel / unlock with the active weapon group
 *   (`components/targetLock.ts`). Hidden for your own hull or a thing that
 *   can't be locked. `data-state` carries the stage for tests.
 * - Cargo (`cargo-open-toggle`): opens the loot window for a storage
 *   structure, a drone or a ship (the server says why when it can't open).
 * - Pod (`pod-open`): opens a cargo pod's loot window; shown only while your
 *   ship is within the open reach, and the window shuts when you leave it.
 * - Pilot (`ship-action-pilot`): take the helm of your own parked hull
 *   (`sendPilotShip`).
 *
 * Returns the icon list (EqxStrip checks its children: icons only) and the
 * loot window, which the host renders beside the strip, not inside it.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { EqxIcon, EqxIconButton } from '../../ui/index.js';
import { useTargetLock } from '../components/targetLock.js';
import { LootWindow } from '../components/LootWindow.js';
import { sendPilotShip } from '../ships/shipActionsClient.js';
import type { PanelData } from '../components/selectionPanelData.js';

export interface SelectionStripItems {
  items: ReactElement[];
  /** The loot window (closed when nothing asked for it); render outside the strip. */
  loot: ReactElement | null;
}

/** Which loot window a cargo / pod icon opens, or null. Pure. */
function lootTarget(d: PanelData | null): { kind: 'pod' | 'cargo'; entityId?: number; ship?: string } | null {
  if (d === null) return null;
  if (d.podOpen === true && d.entityId !== undefined) return { kind: 'pod', entityId: d.entityId };
  if (d.cargoShip !== undefined) return { kind: 'cargo', ship: d.cargoShip };
  if (d.hasCargo === true && d.entityId !== undefined) return { kind: 'cargo', entityId: d.entityId };
  return null;
}

export function useSelectionStripItems(data: PanelData | null): SelectionStripItems {
  const own = data !== null && (data.isOwn === true || data.pilotShipId !== undefined);
  const lock = useTargetLock(own);
  const [lootOpen, setLootOpen] = useState(false);
  const target = lootTarget(data);
  const lootKey = target === null ? null : `${target.kind}:${target.entityId ?? target.ship ?? ''}`;
  // A new selection (or a pod leaving reach) shuts the window.
  useEffect(() => setLootOpen(false), [lootKey]);

  const items: ReactElement[] = [];
  if (lock !== null) {
    items.push(
      <EqxIconButton key="target" variant="strip" icon={<EqxIcon name="target" />} tooltip={lock.tooltip}
        tone={lock.state === 'blocked' ? 'danger' : 'secondary'} active={lock.state === 'unlock' || lock.state === 'cancel'}
        onClick={lock.onClick} data-state={lock.state} data-testid="fc-target" />,
    );
  }
  if (target !== null) {
    const pod = target.kind === 'pod';
    items.push(
      <EqxIconButton key="loot" variant="strip" icon={<EqxIcon name="hold" />} tooltip={pod ? 'Open pod' : 'Open cargo'}
        active={lootOpen} onClick={() => setLootOpen(true)} data-testid={pod ? 'pod-open' : 'cargo-open-toggle'} />,
    );
  }
  if (data?.pilotShipId !== undefined) {
    const shipId = data.pilotShipId;
    items.push(
      <EqxIconButton key="pilot" variant="strip" icon={<EqxIcon name="pilot" />} tooltip="Pilot this ship"
        onClick={() => sendPilotShip(shipId)} data-testid="ship-action-pilot" />,
    );
  }

  let loot: ReactElement | null = null;
  if (target !== null && data !== null) {
    const pod = target.kind === 'pod';
    loot = (
      <LootWindow
        key={lootKey ?? ''}
        open={lootOpen}
        title={pod ? 'Cargo pod' : data.name}
        {...(pod ? { theirsLabel: 'Pod contents' } : {})}
        {...(pod && data.infoLine !== undefined ? { subtitle: data.infoLine } : {})}
        {...(target.ship !== undefined ? { ship: target.ship } : { entityId: target.entityId! })}
        onClose={() => setLootOpen(false)}
      />
    );
  }
  return { items, loot };
}
