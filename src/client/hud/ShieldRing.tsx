/**
 * The status capsule's segmented shield/hull ring, which is also the pilot's
 * shield toggle (owner ask, playtest 2026-11-21): a tap drops the shields, a
 * tap while they are down raises them. The DOWN state comes only from the
 * store's `shieldsLowered` (fed by the own-ship snapshot slice, #16), never
 * from the tap itself; the server owns the rules (`set_shields`).
 *
 * The ring is the only part of the capsule that takes input
 * (`pointerEvents: 'auto'`); the rest lets taps through to the thumb sticks.
 * Touch + click via `useTouchClickActivate` so a tap while steering (a second
 * touch point, which gets no synthesized click) still works.
 */
import { useCallback } from 'react';
import { useUIStore } from '../state/store';
import { useTouchClickActivate } from '../components/touchClickActivate';
import { sendSetShields } from '../net/shieldClient';
import { HUD, hullColor } from './tokens';

/** Dash pattern that shows `pct`% of a ring as 12 segments with gaps. */
function segDash(circ: number, pct: number): string {
  const seg = circ / 12;
  const gap = 1.4;
  const shown = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 12);
  let s = '';
  for (let i = 0; i < 12; i++) s += i < shown ? `${seg - gap} ${gap} ` : `0 ${seg} `;
  return s.trim();
}

export function ShieldRing({ scale }: { scale: number }): JSX.Element {
  const shield = useUIStore((s) => s.shieldPct);
  const hull = useUIStore((s) => s.hullPct);
  const lowered = useUIStore((s) => s.shieldsLowered);
  const { touchActivate, clickActivate } = useTouchClickActivate();
  // Raise when down, drop when up. Reads the store at tap time so a stale
  // closure never sends the wrong direction.
  const toggle = useCallback(() => { sendSetShields(useUIStore.getState().shieldsLowered); }, []);
  const d = Math.round(26 * scale);
  const r1 = d / 2 - 2;
  const r2 = d / 2 - 6;
  const c1 = 2 * Math.PI * r1;
  const c2 = 2 * Math.PI * r2;
  const label = lowered ? 'Raise shields' : 'Drop shields';
  return (
    <div
      data-testid="hud-shield-toggle"
      data-shields={lowered ? 'down' : 'up'}
      role="button"
      aria-pressed={lowered}
      aria-label={label}
      title={label}
      onTouchStart={touchActivate(toggle)}
      onClick={clickActivate(toggle)}
      style={{
        position: 'relative',
        width: d,
        height: d,
        // A bigger tap target than the drawn ring, without moving the layout.
        // content-box: the app-wide border-box would let the padding eat the
        // ring width, so the credits beside it drew over the ring.
        boxSizing: 'content-box',
        padding: 6,
        margin: -6,
        pointerEvents: 'auto',
        cursor: 'pointer',
        touchAction: 'manipulation',
      }}
    >
      <svg width={d} height={d} style={{ transform: 'rotate(-90deg)', opacity: lowered ? 0.45 : 1, display: 'block' }}>
        <circle
          cx={d / 2} cy={d / 2} r={r1} fill="none" strokeWidth={2.5}
          stroke={lowered ? HUD.color.danger : 'rgba(255,255,255,.1)'}
          strokeDasharray={lowered ? '2 2' : undefined}
        />
        <circle
          data-testid="hud-shield"
          cx={d / 2} cy={d / 2} r={r1} fill="none" stroke={HUD.color.shield} strokeWidth={2.5}
          strokeDasharray={segDash(c1, shield)}
        />
        <circle cx={d / 2} cy={d / 2} r={r2} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth={2.5} />
        <circle
          data-testid="hud-hull"
          cx={d / 2} cy={d / 2} r={r2} fill="none" stroke={hullColor(hull)} strokeWidth={2.5}
          strokeDasharray={segDash(c2, hull)}
          style={{ transition: 'stroke 300ms' }}
        />
      </svg>
      {lowered && (
        <span
          data-testid="hud-shield-down"
          style={{
            position: 'absolute',
            // Above the ring, not inside it: the word is wider than the ring's hole.
            left: '50%',
            bottom: '100%',
            transform: 'translate(-50%, 2px)',
            whiteSpace: 'nowrap',
            lineHeight: 1,
            fontSize: Math.max(7, Math.round(7 * scale)),
            fontWeight: 700,
            letterSpacing: 0.3,
            color: HUD.color.danger,
            textShadow: '0 0 3px #000, 0 0 2px #000',
            pointerEvents: 'none',
          }}
        >
          DOWN
        </span>
      )}
    </div>
  );
}
