/**
 * The status capsule's Build-mode body (owner 2026-11-20: "why show health
 * when you have no ship?"). In Build the capsule drops the ship's
 * shield/hull ring and energy bar and shows what matters for building: the
 * base's stored power (your own built batteries in this sector, summed) and
 * the wallet.
 *
 * Stored power is already client-resident (`mirror.structures`, the same
 * slice the inspector's charge bar and the in-world battery bars read), so no
 * new wire field. Read at 2 Hz into local React state, never Zustand (#2) and
 * never per frame (client rule: mirror reads are low-cadence only).
 */
import { useEffect, useState } from 'react';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import { getGameClient } from '../net/clientSingleton';
import type { StructureRenderState } from '@core/contracts/IRenderer';
import { RollingCounter } from './RollingCounter';
import { HUD } from './tokens';

export interface BaseCharge {
  stored: number;
  max: number;
}

/** Sum of stored / max power over the local player's BUILT structures. Pure. */
export function sumOwnStoredPower(
  structures: ReadonlyMap<number, StructureRenderState> | undefined,
  localPlayerId: string | null,
): BaseCharge {
  let stored = 0;
  let max = 0;
  if (!structures || localPlayerId === null) return { stored, max };
  for (const st of structures.values()) {
    if (st.owner !== localPlayerId || !st.built) continue;
    const m = st.storedPowerMax ?? 0;
    if (m <= 0) continue;
    max += m;
    stored += Math.max(0, Math.min(m, st.storedPower ?? 0));
  }
  return { stored: Math.round(stored), max: Math.round(max) };
}

const POLL_MS = 500;

/** The base's stored power, re-read twice a second; re-renders only on change. */
function useBaseCharge(): BaseCharge {
  const [charge, setCharge] = useState<BaseCharge>({ stored: 0, max: 0 });
  useEffect(() => {
    const read = (): void => {
      const c = getGameClient();
      const next = sumOwnStoredPower(c?.mirror.structures, c?.mirror.localPlayerId ?? null);
      setCharge((prev) => (prev.stored === next.stored && prev.max === next.max ? prev : next));
    };
    read();
    // -- real time: a UI poll cadence, not game time.
    const id = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(id);
  }, []);
  return charge;
}

/** Build-mode capsule body: base stored power (when there is a battery) + credits. */
export function BuildStatusBody({ scale, wallet }: { scale: number; wallet: number | null }): JSX.Element {
  const { stored, max } = useBaseCharge();
  const fs = Math.round(10.5 * scale);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 6 }}>
      {max > 0 && (
        <div
          data-testid="hud-base-power"
          data-stored={stored}
          data-max={max}
          title="Base stored power"
          style={{ display: 'flex', alignItems: 'center', gap: 2, fontFamily: HUD.font.num, fontSize: fs, color: HUD.color.energy }}
        >
          <BatteryChargingFullIcon sx={{ fontSize: Math.round(14 * scale) }} />
          <span>{stored}/{max}</span>
        </div>
      )}
      <div data-testid="wallet-chip" data-wallet={wallet ?? undefined}>
        <RollingCounter value={wallet} size={fs} />
      </div>
    </div>
  );
}
