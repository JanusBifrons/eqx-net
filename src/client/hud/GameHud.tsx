/**
 * The piloting HUD (fire control). Rendered by App's GameSurface; every other
 * in-game overlay (prompts, toasts, helm, inspector, drawer, warp map, cargo)
 * is mounted by App directly.
 *
 *  - Top: status capsule (shield/hull rings, energy, credits) + the lock
 *    status band (top-centre), sector chip (top-left), speed dial (top-right),
 *    weapon strip (right edge, one chip per weapon group).
 *  - Desktop: hold LMB on a ship to lock it (MouseLock.ts), RMB boost, the
 *    build palette (BottomControlPanel) while spectating, and a key hint.
 *  - Touch: floating move stick (left thumb), lock-line stick + BOOST (right).
 *
 * Every weapon group fires only at a target it has a completed lock on.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useShouldRenderHud, useUIStore } from '../state/store';
import type { TouchInput } from '../input/TouchInput';
import { Slot } from '../layout/Slot';
import { SpeedDialMenu } from '../components/SpeedDialMenu';
import { BottomControlPanel } from '../components/BottomControlPanel';
import { getGameClient } from '../net/clientSingleton';
import { FloatingStick } from './FloatingStick';
import type { StickVec } from './floatingStickMath';
import { RollingCounter } from './RollingCounter';
import { HUD, hullColor } from './tokens';
import { hudScale, useHudSize } from './useHudScale';
import { WeaponStrip } from './WeaponStrip';
import { LockStatusBand } from './LockStatusBand';
import { stickToWorldBearing } from '@core/combat/manualAim';
import { HoldButton, SectorChip, useEnergyFill, useFakeCredits } from './widgets';

interface Props {
  /** Present on touch devices only. */
  touchInput: TouchInput | null;
}

/** Edge inset for thumb controls (px), on top of the safe-area padding. */
const THUMB_INSET = 22;

export function GameHud({ touchInput }: Props): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const spectating = useUIStore((s) => s.pilotMode === 'spectator');
  const isDead = useUIStore((s) => s.isDead);
  const size = useHudSize();
  const scale = hudScale(size);
  useFakeCredits();
  useEffect(() => {
    document.documentElement.classList.add('eqx-game-hud');
    return () => document.documentElement.classList.remove('eqx-game-hud');
  }, []);

  if (!shouldRender) return null;
  const flying = !spectating && !isDead;
  const touch = touchInput !== null;

  return (
    <>
      {/* ── Top ─────────────────────────────────────────────────────────── */}
      <Slot anchor="top-center" order={0}><StatusCapsule scale={scale} /></Slot>
      {flying && <Slot anchor="top-center" order={1}><LockStatusBand scale={scale} /></Slot>}
      <Slot anchor="top-left" order={1}><SectorChip size={Math.round(9 * scale)} /></Slot>
      {flying && <FcStripDock scale={scale} />}
      <Slot anchor="top-right" order={2}><SpeedDialMenu direction="down" /></Slot>

      {/* ── Desktop ─────────────────────────────────────────────────────── */}
      {/* The build palette while spectating (the weapon strip replaces the old weapon-slot bar). */}
      {!touch && <Slot anchor="bottom-center" order={1}><BottomControlPanel /></Slot>}
      {!touch && flying && (
        <Slot anchor="bottom-right" order={1}><DesktopFcHint scale={scale} /></Slot>
      )}

      {/* ── Touch controls ──────────────────────────────────────────────── */}
      {touch && flying && touchInput && (
        <>
          <MoveStick touchInput={touchInput} />
          <LockCluster touchInput={touchInput} />
        </>
      )}
    </>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────

/** Compact status capsule: segmented shield/hull ring + energy + credits. */
function StatusCapsule({ scale }: { scale: number }): JSX.Element {
  const shield = useUIStore((s) => s.shieldPct);
  const hull = useUIStore((s) => s.hullPct);
  const wallet = useUIStore((s) => s.wallet);
  const energyRef = useEnergyFill();
  const d = Math.round(26 * scale);
  const r1 = d / 2 - 2;
  const r2 = d / 2 - 6;
  const c1 = 2 * Math.PI * r1;
  const c2 = 2 * Math.PI * r2;
  return (
    <div
      data-testid="hud-status"
      data-hud-exclusion=""
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 10px 3px 4px',
        borderRadius: 999,
        background: HUD.color.panel,
        border: `1px solid ${HUD.color.panelEdge}`,
        backdropFilter: 'blur(3px)',
        pointerEvents: 'none',
      }}
    >
      <svg width={d} height={d} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={d / 2} cy={d / 2} r={r1} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth={2.5} />
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ width: Math.round(70 * scale), height: 3, background: 'rgba(255,255,255,.1)', borderRadius: 3, overflow: 'hidden' }}>
          <div ref={energyRef} data-testid="hud-energy" style={{ width: '100%', height: '100%', background: HUD.color.energy, transformOrigin: 'left center' }} />
        </div>
        <div data-testid="wallet-chip" data-wallet={wallet ?? undefined}>
          <RollingCounter value={wallet} size={Math.round(10.5 * scale)} />
        </div>
      </div>
    </div>
  );
}

/** Dash pattern that shows `pct`% of a ring as 12 segments with gaps. */
function segDash(circ: number, pct: number): string {
  const seg = circ / 12;
  const gap = 1.4;
  const shown = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 12);
  let s = '';
  for (let i = 0; i < 12; i++) s += i < shown ? `${seg - gap} ${gap} ` : `0 ${seg} `;
  return s.trim();
}

/** Left thumb: floating move stick. */
function MoveStick({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const onMove = useCallback(
    (v: StickVec) => {
      // joystickToInput expects y UP-positive (nipplejs convention).
      touchInput.setJoystick({ x: v.x, y: -v.y });
    },
    [touchInput],
  );
  const onEnd = useCallback(() => touchInput.setJoystickIdle(), [touchInput]);
  return (
    <FloatingStick
      id="hud-move"
      zone={{ left: 0, top: '28%', width: '44%', bottom: 0 }}
      home={{ left: THUMB_INSET, bottom: THUMB_INSET }}
      radius={50}
      knob={42}
      color="#9fd8ff"
      onMove={onMove}
      onEnd={onEnd}
    />
  );
}


// ── Fire control ─────────────────────────────────────────────────────────────

/** Weapon strip, right edge, vertically centred (above the right thumb zone). */
function FcStripDock({ scale }: { scale: number }): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        right: 'calc(env(safe-area-inset-right, 0px) + 14px)',
        top: '50%',
        transform: 'translateY(-62%)',
        zIndex: 18,
        pointerEvents: 'none',
      }}
    >
      <WeaponStrip scale={scale} />
    </div>
  );
}

/**
 * Right thumb: the lock line. Drag anywhere in the right zone — a line leaves
 * the ship along the drag and the target nearest it lights up. Keep it there
 * and the active group's lock builds; slide off or let go before it finishes
 * and the lock drains back to 0. (Hands-off: tap a ship, then Lock in its
 * info box.) Re-checked 10×/s while held, so a moving target stays held.
 */
function LockCluster({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const bearing = useRef(NaN);
  const timer = useRef<number | null>(null);
  const onMove = useCallback((v: StickVec) => {
    bearing.current = v.mag > 0.25 ? stickToWorldBearing(v.x, v.y) : NaN;
    getGameClient()?.guideLock(bearing.current);
    if (timer.current === null) {
      timer.current = window.setInterval(() => getGameClient()?.guideLock(bearing.current), 100);
    }
  }, []);
  const onEnd = useCallback(() => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; }
    bearing.current = NaN;
    getGameClient()?.releaseLockGuide();
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearInterval(timer.current); }, []);
  const base = THUMB_INSET + 6;
  return (
    <>
      <FloatingStick
        id="hud-lock"
        zone={{ right: 0, top: '28%', width: '44%', bottom: 0 }}
        home={{ right: base + 70, bottom: base }}
        radius={46}
        knob={36}
        color={HUD.color.danger}
        onMove={onMove}
        onEnd={onEnd}
        idleOpacity={0.5}
        zIndex={16}
      >
        <svg width={18} height={18} viewBox="0 0 20 20" style={{ opacity: 0.9 }}>
          <path d="M2 7V2h5M13 2h5v5M18 13v5h-5M7 18H2v-5" fill="none" stroke="#fff" strokeWidth={1.6} />
        </svg>
      </FloatingStick>
      <div
        style={{
          position: 'fixed',
          right: `calc(env(safe-area-inset-right, 0px) + ${base}px)`,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${base}px)`,
          zIndex: 17,
        }}
      >
        <HoldButton testId="hud-boost" size={46} color={HUD.color.boost} onHold={(d) => touchInput.setBoostHeld(d)}>
          BOOST
        </HoldButton>
      </div>
    </>
  );
}

function DesktopFcHint({ scale }: { scale: number }): JSX.Element {
  const fs = Math.round(9 * scale) - 1;
  const k = (t: string): JSX.Element => <b style={{ color: HUD.color.inkDim }}>{t}</b>;
  return (
    <div data-testid="hud-fc-hint" style={{ fontFamily: HUD.font.label, fontSize: fs, color: HUD.color.inkFaint, letterSpacing: 0.6, textAlign: 'right', lineHeight: 1.6 }}>
      <div>{k('HOLD LMB')} on a ship to lock · {k('T')} lock selected · {k('X')} clear</div>
      <div>{k('1–9')} group · {k('SHIFT+1–9')} auto/man · {k('RMB')} boost</div>
    </div>
  );
}
