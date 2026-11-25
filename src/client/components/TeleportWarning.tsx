/**
 * v4 T2 — "the doors are closing": warns a pilot whose ship sits on a
 * teleporter pad while that pad's jump cycle runs. Everyone on either pad
 * rides, strangers included, so the warning says how to get off.
 *
 * Derived on the client from room state (#16): the pad's phase rides the
 * teleporter's room-state row, and the ship's pose is in the render mirror.
 * Polled a few times a second; React re-renders only when the text changes.
 * Drawn as an amber EqxPrompt readout (top centre).
 */
import { memo, useEffect, useState } from 'react';
import { EqxPrompt } from '../../ui/index.js';
import { getGameClient } from '../net/clientSingleton';
import { TP_PHASE, isTeleporterKind, onPad } from '../../shared-types/teleport';

const POLL_MS = 200;

const TEXT: Readonly<Record<number, string>> = {
  [TP_PHASE.ARMED]: 'Teleport departing. Stay on the pad to ride, or fly off now.',
  [TP_PHASE.CLOSING]: 'Doors closing.',
  [TP_PHASE.SEALED]: 'Sealed. Charging up…',
};

/** The jump phase of the pad the local ship sits on (0 when none). */
export function localPadPhase(): number {
  const m = getGameClient()?.mirror;
  const id = m?.localPlayerId;
  const me = id ? m?.ships.get(id) : undefined;
  if (!m || !me || !m.structures || !m.swarm) return 0;
  for (const [eid, st] of m.structures) {
    const phase = st.teleport?.phase ?? 0;
    if (phase === 0) continue;
    const e = m.swarm.get(eid);
    if (e && isTeleporterKind(e.shipKind) && onPad(e.shipKind, e.x, e.y, me.x, me.y)) return phase;
  }
  return 0;
}

export const TeleportWarning = memo(function TeleportWarning(): JSX.Element | null {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPhase(localPadPhase()), POLL_MS);
    return () => clearInterval(t);
  }, []);
  const text = TEXT[phase];
  if (text === undefined) return null;
  return <EqxPrompt tone="warn" message={text} data-testid="teleport-warning" dataAttrs={{ phase }} />;
});
