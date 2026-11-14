/**
 * Fire Control lock status (exp/fire-control, `?ui=d`), top-centre band.
 *
 *  - Threat row (red): who is locking YOU. "⚠ LOCKED · Fighter ×2" flashes the
 *    moment a lock completes; while one only builds it reads
 *    "LOCKING YOU · Heavy 60%". Sources: the own-ship `lockedBy` slice (#16).
 *  - Own row: the lock you're building, "FORE → Fighter · 62%" in the group
 *    colour (yellow while the failsafe runs on a neutral).
 *
 * Percentages change ~10×/s, so this polls the render mirror at 10 Hz and
 * only re-renders when the shown text changes (never a per-frame Zustand
 * write, invariant #2). Names come from the ship kind, never an id.
 */
import { useEffect, useState } from 'react';
import { getShipKind } from '@shared-types/shipKinds';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getGameClient } from '../net/clientSingleton';
import { useUIStore } from '../state/store';
import { FAILSAFE_COLOUR, THREAT_COLOUR_HEX, groupColourHex } from './groupColours';
import { HUD } from './tokens';
import { acquiringPct, acquiringRank } from './lockPct';

export interface ThreatSummary {
  locked: number;
  lockedName: string;
  acquiring: number;
  /** The closest-to-done acquiring lock. */
  acquiringName: string;
  acquiringPct: number;
}

export interface OwnLockSummary {
  group: string;
  groupIndex: number;
  target: string;
  pct: number;
  failsafe: boolean;
  /** Let go before it finished: draining back to 0. */
  losing: boolean;
}

function nameOf(mirror: RenderMirror, key: string): string {
  if (key.startsWith('s:')) {
    const e = mirror.swarm?.get(Number(key.slice(2)));
    if (e?.kind === 2) return 'Structure';
    return e?.shipKind ? getShipKind(e.shipKind).displayName : 'Ship';
  }
  const s = mirror.ships.get(key.slice(2));
  return s?.displayName ?? (s?.kind ? getShipKind(s.kind).displayName : 'Pilot');
}

/** Pure: summarise the NPC locks on the local ship. */
export function summariseThreats(mirror: RenderMirror): ThreatSummary | null {
  const list = mirror.localLockedBy;
  if (!list || list.length === 0) return null;
  const out: ThreatSummary = { locked: 0, lockedName: '', acquiring: 0, acquiringName: '', acquiringPct: -1 };
  const lockedNames = new Set<string>();
  for (const l of list) {
    const n = nameOf(mirror, l.t);
    if (l.s === 2) { out.locked++; lockedNames.add(n); }
    else {
      out.acquiring++;
      if (l.p > out.acquiringPct) { out.acquiringPct = l.p; out.acquiringName = n; }
    }
  }
  if (out.acquiring > 0) out.acquiringPct = acquiringPct(out.acquiringPct);
  // One kind: "Fighter" (+ " ×2" in the view). Mixed kinds: "3 ships".
  out.lockedName = lockedNames.size === 1 ? [...lockedNames][0]! : `${out.locked} ships`;
  return out;
}

/** Pure: the most advanced lock the pilot is still building (null = none). */
export function summariseOwnLock(mirror: RenderMirror, names: ReadonlyArray<string>): OwnLockSummary | null {
  const groups = mirror.localGroups;
  if (!groups) return null;
  let best: OwnLockSummary | null = null;
  let bestRank = -1;
  for (let gi = 0; gi < groups.length; gi++) {
    for (const l of groups[gi]!.l) {
      if (l.s === 2) continue;
      const rank = acquiringRank(l);
      if (best && rank <= bestRank) continue;
      bestRank = rank;
      best = { group: names[gi] ?? groups[gi]!.id, groupIndex: gi, target: nameOf(mirror, l.t), pct: l.p, failsafe: l.s === 0, losing: l.r === 1 };
    }
  }
  if (best) best.pct = acquiringPct(best.pct);
  return best;
}

const FLASH_CSS = '@keyframes eqxFcThreat{0%,100%{opacity:1}50%{opacity:.55}}.eqx-fc-threat-locked{animation:eqxFcThreat .6s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.eqx-fc-threat-locked{animation:none}}';

function sig(t: ThreatSummary | null, o: OwnLockSummary | null): string {
  return `${t ? `${t.locked}|${t.lockedName}|${t.acquiring}|${t.acquiringName}|${Math.floor(t.acquiringPct / 5)}` : '-'}#${
    o ? `${o.group}|${o.target}|${Math.floor(o.pct / 2)}|${o.failsafe}|${o.losing}` : '-'}`;
}

export function LockStatusBand({ scale = 1 }: { scale?: number }): JSX.Element | null {
  const groupNames = useUIStore((s) => s.fcGroups);
  const [state, setState] = useState<{ t: ThreatSummary | null; o: OwnLockSummary | null; k: string }>({ t: null, o: null, k: '-#-' });
  useEffect(() => {
    const names = groupNames.map((g) => g.name);
    const tick = (): void => {
      const m = getGameClient()?.mirror;
      if (!m) return;
      const t = summariseThreats(m);
      const o = summariseOwnLock(m, names);
      const k = sig(t, o);
      setState((prev) => (prev.k === k ? prev : { t, o, k }));
    };
    tick();
    const h = window.setInterval(tick, 100);
    return () => window.clearInterval(h);
  }, [groupNames]);

  const { t, o } = state;
  if (!t && !o) return null;
  const fs = Math.max(9, Math.round(10 * scale));
  const row = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 4, fontFamily: HUD.font.label, fontWeight: 700, fontSize: fs, letterSpacing: 1, whiteSpace: 'nowrap' as const };
  return (
    <div data-testid="fc-lock-band" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>
      <style>{FLASH_CSS}</style>
      {t && (
        <div
          data-testid="fc-threats"
          data-locked={t.locked}
          data-acquiring={t.acquiring}
          className={t.locked > 0 ? 'eqx-fc-threat-locked' : undefined}
          style={{
            ...row,
            color: t.locked > 0 ? '#fff' : THREAT_COLOUR_HEX,
            background: t.locked > 0 ? THREAT_COLOUR_HEX : 'rgba(30,4,8,.8)',
            border: `1px solid ${THREAT_COLOUR_HEX}`,
            boxShadow: `0 0 12px ${THREAT_COLOUR_HEX}66`,
          }}
        >
          <span aria-hidden>⚠</span>
          {t.locked > 0 && (
            <span>
              {t.lockedName.endsWith(' ships')
                ? `${t.lockedName.toUpperCase()} HAVE YOU LOCKED`
                : `${t.lockedName.toUpperCase()}${t.locked > 1 ? ` ×${t.locked}` : ''} ${t.locked > 1 ? 'HAVE' : 'HAS'} YOU LOCKED`}
            </span>
          )}
          {t.locked > 0 && t.acquiring > 0 && <span style={{ opacity: 0.6 }}>|</span>}
          {t.acquiring > 0 && (
            <span>
              {t.locked > 0 ? '+ ' : ''}{t.acquiringName} LOCKING ON YOU <span style={{ fontFamily: HUD.font.num }}>{t.acquiringPct}%</span>
            </span>
          )}
        </div>
      )}
      {o && (
        <div
          data-testid="fc-own-lock"
          data-pct={o.pct}
          data-losing={o.losing ? '1' : '0'}
          style={{
            ...row,
            color: o.failsafe ? `#${FAILSAFE_COLOUR.toString(16)}` : groupColourHex(o.groupIndex),
            background: 'rgba(6,10,20,.75)',
            border: `1px solid ${o.failsafe ? `#${FAILSAFE_COLOUR.toString(16)}` : groupColourHex(o.groupIndex)}`,
          }}
        >
          <span>{o.group.toUpperCase()} → {o.target}</span>
          <span style={{ opacity: 0.7 }}>{o.losing ? 'LOSING LOCK' : o.failsafe ? 'FAILSAFE' : 'LOCKING'}</span>
          <span style={{ fontFamily: HUD.font.num }}>{o.pct}%</span>
          <span style={{ width: 46, height: 3, background: 'rgba(255,255,255,.15)', borderRadius: 2, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${o.pct}%`, background: 'currentColor' }} />
          </span>
        </div>
      )}
    </div>
  );
}
