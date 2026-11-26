/**
 * v4 T2 — "the doors are closing": warns a pilot whose ship sits on a
 * teleporter pad (or inside an Ancients' gate's ring) while its jump cycle
 * runs. Everyone aboard rides, strangers included, so the warning says how
 * to get off. The gate has no pad and no doors, so it gets its own words.
 *
 * Derived on the client from room state (#16): the pad's phase rides the
 * teleporter's room-state row, and the ship's pose is in the render mirror.
 * Polled a few times a second; React re-renders only when the text changes.
 * Drawn as an amber EqxPrompt readout (top centre).
 */
import { memo, useEffect, useState } from 'react';
import { EqxPrompt } from '../../ui/index.js';
import { getGameClient } from '../net/clientSingleton';
import { TP_PHASE, isAlienGateKind, isTeleporterKind, onPad } from '../../shared-types/teleport';

const POLL_MS = 200;

const PAD_TEXT: Readonly<Record<number, string>> = {
  [TP_PHASE.ARMED]: 'Teleport departing. Stay on the pad to ride, or fly off now.',
  [TP_PHASE.CLOSING]: 'Doors closing.',
  [TP_PHASE.SEALED]: 'Sealed. Charging up…',
};

/** The Ancients' gate has no pad and no doors: its inner ring, round the light pool, seals. */
const GATE_TEXT: Readonly<Record<number, string>> = {
  [TP_PHASE.ARMED]: 'Gate jumping soon. Stay inside the ring to ride, or fly out now.',
  [TP_PHASE.CLOSING]: 'Inner ring closing.',
  [TP_PHASE.SEALED]: 'Sealed. Charging up…',
};

/** The warning for a pilot aboard a jumper of this kind in this phase (undefined: none). */
export function warningText(kind: string, phase: number): string | undefined {
  return (isAlienGateKind(kind) ? GATE_TEXT : PAD_TEXT)[phase];
}

/** The warning for the jumper the local ship sits on (undefined when none or idle). */
export function localPadWarning(): { phase: number; text: string } | undefined {
  const c = getGameClient();
  // The jump already fired: the picture holds the old room (ship still on the
  // sealed gate) until landing, so a warning would say "charging" after it.
  if (c?.holdingPicture() === true) return undefined;
  const m = c?.mirror;
  const id = m?.localPlayerId;
  const me = id ? m?.ships.get(id) : undefined;
  if (!m || !me || !m.structures || !m.swarm) return undefined;
  for (const [eid, st] of m.structures) {
    const phase = st.teleport?.phase ?? 0;
    if (phase === 0) continue;
    const e = m.swarm.get(eid);
    if (e && isTeleporterKind(e.shipKind) && onPad(e.shipKind, e.x, e.y, me.x, me.y, e.angle)) {
      const text = warningText(e.shipKind, phase);
      return text === undefined ? undefined : { phase, text };
    }
  }
  return undefined;
}

export const TeleportWarning = memo(function TeleportWarning(): JSX.Element | null {
  const [phase, setPhase] = useState(0);
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    const t = setInterval(() => {
      const w = localPadWarning();
      setPhase(w?.phase ?? 0);
      setText(w?.text);
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);
  if (text === undefined) return null;
  return <EqxPrompt tone="warn" message={text} data-testid="teleport-warning" dataAttrs={{ phase }} />;
});
