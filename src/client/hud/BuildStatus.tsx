/**
 * The status capsule's base readouts (owner 2026-11-20: "why show health
 * when you have no ship?"). In Build the capsule drops the ship's
 * shield/hull ring and energy bar and shows what matters for building: the
 * base's stored power (your own built batteries in this sector, summed) and
 * the wallet. Flying or building, the credits carry the MINERAL BANK beside
 * them (owner 2026-11-21: a build stalled on an empty bank while the only
 * number on screen was "¢ 0"): the minerals in your own Capital(s) here, the
 * pool construction draws from.
 *
 * Stored power and the bank are already client-resident (`mirror.structures`
 * from room state, the same slice the inspector's charge bar and the
 * in-world Capital readout read; the kind from `mirror.swarm`), so no new
 * wire field. Read at 2 Hz into local React state, never Zustand (#2) and
 * never per frame (client rule: mirror reads are low-cadence only).
 */
import { useEffect, useState } from 'react';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import { getGameClient } from '../net/clientSingleton';
import type { StructureRenderState } from '@core/contracts/IRenderer';
import { RollingCounter, formatCredits } from './RollingCounter';
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

/**
 * The mineral bank: minerals held by the local player's BUILT Capitals here
 * (construction draws only from a Capital; a miner's buffer is not the bank).
 * `null` when you own no Capital in this sector (nothing to show). Pure.
 */
export function sumOwnCapitalMinerals(
  structures: ReadonlyMap<number, StructureRenderState> | undefined,
  kinds: ReadonlyMap<number, { shipKind?: string }> | undefined,
  localPlayerId: string | null,
): number | null {
  if (!structures || !kinds || localPlayerId === null) return null;
  let bank: number | null = null;
  for (const [id, st] of structures) {
    if (st.owner !== localPlayerId || !st.built || kinds.get(id)?.shipKind !== 'capital') continue;
    bank = (bank ?? 0) + Math.max(0, st.minerals ?? 0);
  }
  return bank === null ? null : Math.floor(bank);
}

export interface BaseBank extends BaseCharge {
  /** Capital minerals; null = no own Capital here. */
  minerals: number | null;
}

const POLL_MS = 500;
const EMPTY_BANK: BaseBank = { stored: 0, max: 0, minerals: null };

/** The base's stored power + mineral bank, re-read twice a second; re-renders only on change. */
export function useBaseBank(): BaseBank {
  const [bank, setBank] = useState<BaseBank>(EMPTY_BANK);
  useEffect(() => {
    const read = (): void => {
      const c = getGameClient();
      const me = c?.mirror.localPlayerId ?? null;
      const charge = sumOwnStoredPower(c?.mirror.structures, me);
      const minerals = sumOwnCapitalMinerals(c?.mirror.structures, c?.mirror.swarm, me);
      setBank((prev) => (prev.stored === charge.stored && prev.max === charge.max && prev.minerals === minerals
        ? prev
        : { ...charge, minerals }));
    };
    read();
    // -- real time: a UI poll cadence, not game time.
    const id = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(id);
  }, []);
  return bank;
}

/** The mineral bank chip (`◆ 5,000`), same small numeric style as the credits; amber when empty. */
export function MineralBank({ minerals, fs }: { minerals: number | null; fs: number }): JSX.Element | null {
  if (minerals === null) return null;
  const empty = minerals <= 0;
  return (
    <span
      data-testid="hud-minerals"
      data-minerals={minerals}
      data-empty={empty ? '1' : undefined}
      title="Mineral bank (your Capital): pays for construction"
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 3,
        color: empty ? HUD.color.hullWarn : HUD.color.ink,
        fontFamily: HUD.font.num,
        fontSize: fs,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      <span style={{ fontFamily: HUD.font.label, opacity: 0.85 }}>◆</span>
      <span>{formatCredits(minerals)}</span>
    </span>
  );
}

/** Credits + mineral bank on one line (the flying capsule's money row). */
export function WalletRow({ wallet, fs }: { wallet: number | null; fs: number }): JSX.Element {
  const { minerals } = useBaseBank();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <div data-testid="wallet-chip" data-wallet={wallet ?? undefined}>
        <RollingCounter value={wallet} size={fs} />
      </div>
      <MineralBank minerals={minerals} fs={fs} />
    </div>
  );
}

/** Build-mode capsule body: base stored power (when there is a battery) + credits + mineral bank. */
export function BuildStatusBody({ scale, wallet }: { scale: number; wallet: number | null }): JSX.Element {
  const { stored, max, minerals } = useBaseBank();
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
      <MineralBank minerals={minerals} fs={fs} />
    </div>
  );
}
