/**
 * The three experimental piloting HUDs (exp/hud-mobile-first), selected by
 * `?ui=a|b|c` (see uiVariant.ts). Rendered by App's GameSurface IN PLACE OF
 * the legacy SectorInfoPanel / ShieldHullBar / WalletChip / EnergyBar /
 * MobileControls / AutoFireToggleButton / SpeedDialMenu; every other in-game
 * overlay (prompts, toasts, helm, inspector, drawer, warp map) is unchanged.
 *
 *  A "Corner Clusters" — floating move stick; one big always-on FIRE (auto
 *    glow + hold-to-override) with an AUTO/MAN pill; BOOST beside it; hairline
 *    status stack + credits top-left.
 *  B "Twin-Stick" — floating move stick + floating AIM stick (drag = manual
 *    aim & fire, release = back to auto); status lives on the ship (Pixi
 *    arcs); thin top strip.
 *  C "Smart Attack" — floating move stick; one attack button: tap = fire at
 *    the auto-lock, press-and-drag = aim & fire; Boost + Slot satellites;
 *    status capsule top-centre.
 *
 * Desktop (fine pointer) gets the same top layout per variant plus a
 * fire-mode chip; aiming is the mouse (hold left button), see MouseAim.ts.
 */
import { useCallback, useEffect } from 'react';
import { useShouldRenderHud, useUIStore } from '../state/store';
import type { TouchInput } from '../input/TouchInput';
import { aimInput } from '../input/AimInput';
import { Slot } from '../layout/Slot';
import { SpeedDialMenu } from '../components/SpeedDialMenu';
import { BottomControlPanel } from '../components/BottomControlPanel';
import { getGameClient } from '../net/clientSingleton';
import { getShipKind } from '@shared-types/shipKinds';
import { FloatingStick } from './FloatingStick';
import type { StickVec } from './floatingStickMath';
import { RollingCounter } from './RollingCounter';
import { HUD, hullColor } from './tokens';
import { hudScale, useHudSize } from './useHudScale';
import type { UiVariant } from './uiVariant';
import { WeaponStrip } from './WeaponStrip';
import { stickToWorldBearing } from '@core/combat/manualAim';
import {
  AutoPip,
  CooldownRing,
  HoldButton,
  SectorChip,
  StatusStack,
  fireLookColor,
  useEnergyFill,
  useFakeCredits,
  useFireLook,
} from './widgets';

interface Props {
  variant: Exclude<UiVariant, 'legacy'>;
  /** Present on touch devices only. */
  touchInput: TouchInput | null;
}

/** Edge inset for thumb controls (px), on top of the safe-area padding. */
const THUMB_INSET = 22;

export function ExperimentalHud({ variant, touchInput }: Props): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const spectating = useUIStore((s) => s.pilotMode === 'spectator');
  const isDead = useUIStore((s) => s.isDead);
  const size = useHudSize();
  const scale = hudScale(size);
  useFakeCredits();
  useEffect(() => {
    document.documentElement.classList.add('eqx-ui-exp', `eqx-ui-${variant}`);
    return () => document.documentElement.classList.remove('eqx-ui-exp', `eqx-ui-${variant}`);
  }, [variant]);

  if (!shouldRender) return null;
  const flying = !spectating && !isDead;
  const touch = touchInput !== null;

  return (
    <>
      {/* ── Top ─────────────────────────────────────────────────────────── */}
      {variant === 'a' && (
        <>
          <Slot anchor="top-left" order={1}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <StatusStack scale={scale} />
              <Credits scale={scale} />
            </div>
          </Slot>
          <Slot anchor="top-right" order={3}><SectorChip size={Math.round(9 * scale)} /></Slot>
        </>
      )}
      {variant === 'b' && (
        <>
          <Slot anchor="top-left" order={1}><SectorChip size={Math.round(9 * scale)} /></Slot>
          <Slot anchor="top-left" order={2}><Credits scale={scale} /></Slot>
          {/* Status lives on the ship (Pixi arcs). A tiny numeric fallback
              keeps exact values one glance away. */}
          <Slot anchor="top-left" order={3}><MiniNumbers scale={scale} /></Slot>
        </>
      )}
      {variant === 'c' && (
        <>
          <Slot anchor="top-center" order={0}><StatusCapsule scale={scale} /></Slot>
          <Slot anchor="top-left" order={1}><SectorChip size={Math.round(9 * scale)} /></Slot>
        </>
      )}
      {variant === 'd' && (
        <>
          <Slot anchor="top-center" order={0}><StatusCapsule scale={scale} /></Slot>
          <Slot anchor="top-left" order={1}><SectorChip size={Math.round(9 * scale)} /></Slot>
          {flying && <FcStripDock scale={scale} />}
        </>
      )}
      <Slot anchor="top-right" order={2}><SpeedDialMenu direction="down" /></Slot>

      {/* ── Desktop ─────────────────────────────────────────────────────── */}
      {!touch && <Slot anchor="bottom-center" order={1}><BottomControlPanel /></Slot>}
      {!touch && flying && variant !== 'd' && (
        <Slot anchor="bottom-right" order={1}><DesktopFireChip scale={scale} /></Slot>
      )}
      {!touch && flying && variant === 'd' && (
        <Slot anchor="bottom-right" order={1}><DesktopFcHint scale={scale} /></Slot>
      )}

      {/* ── Touch controls ──────────────────────────────────────────────── */}
      {touch && flying && touchInput && (
        <>
          <MoveStick touchInput={touchInput} />
          {variant === 'a' && <ClusterA touchInput={touchInput} />}
          {variant === 'b' && <ClusterB touchInput={touchInput} />}
          {variant === 'c' && <ClusterC touchInput={touchInput} />}
          {variant === 'd' && <ClusterD touchInput={touchInput} />}
        </>
      )}
    </>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function Credits({ scale }: { scale: number }): JSX.Element {
  const wallet = useUIStore((s) => s.wallet);
  return (
    <div data-testid="wallet-chip" data-wallet={wallet ?? undefined} data-hud-exclusion="" style={{ minHeight: 12 }}>
      <RollingCounter value={wallet} size={Math.round(11 * scale)} />
    </div>
  );
}

function MiniNumbers({ scale }: { scale: number }): JSX.Element {
  const shield = useUIStore((s) => s.shieldPct);
  const hull = useUIStore((s) => s.hullPct);
  const fs = Math.round(8.5 * scale);
  return (
    <div
      data-testid="hud-status"
      data-hud-exclusion=""
      style={{ fontFamily: HUD.font.num, fontSize: fs, display: 'flex', gap: 8, pointerEvents: 'none', letterSpacing: 0.3 }}
    >
      <span style={{ color: HUD.color.shield }}>◈ {Math.min(100, Math.round(shield))}</span>
      <span style={{ color: hullColor(hull) }}>✚ {Math.min(100, Math.round(hull))}</span>
    </div>
  );
}

/** C — compact status capsule: segmented shield/hull ring + energy + credits. */
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

function useAutoToggle(): () => void {
  return useCallback(() => {
    const s = useUIStore.getState();
    s.setAutoFireEnabled(!s.autoFireEnabled);
  }, []);
}

function cycleSlot(): void {
  const c = getGameClient();
  const id = c?.mirror.localPlayerId;
  const kind = id ? c?.mirror.ships.get(id)?.kind : undefined;
  if (!kind) return;
  const slots = getShipKind(kind).slots ?? [];
  if (slots.length === 0) return;
  const st = useUIStore.getState();
  const idx = slots.findIndex((s) => s.id === st.activeSlotId);
  const next = slots[(idx + 1) % slots.length];
  if (next) st.setActiveSlotId(next.id);
}

/** Left thumb: floating move stick (all variants). */
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


/** Small AUTO/MAN pill with an oversized touch area. */
function ModePill({ style }: { style?: React.CSSProperties }): JSX.Element {
  const look = useFireLook();
  const autoOn = useUIStore((s) => s.autoFireEnabled);
  const toggle = useAutoToggle();
  const color = autoOn ? HUD.color.auto : 'rgba(190,200,215,.8)';
  return (
    <div
      data-testid="hud-auto-toggle"
      data-state={autoOn ? 'on' : 'off'}
      data-hud-exclusion=""
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }}
      style={{
        position: 'absolute',
        padding: 12, // invisible hit-slop around the 18 px pill
        margin: -12,
        touchAction: 'none',
        pointerEvents: 'auto',
        cursor: 'pointer',
        ...style,
      }}
    >
      <div
        style={{
          height: 16,
          padding: '0 7px',
          borderRadius: 9,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: HUD.font.label,
          fontWeight: 700,
          fontSize: 8.5,
          letterSpacing: 1,
          color,
          border: `1px solid ${color}`,
          background: autoOn ? 'rgba(52,216,255,.14)' : 'rgba(6,10,20,.6)',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: look === 'engaged' ? HUD.color.auto : look === 'manual' ? HUD.color.manual : 'transparent',
            border: `1px solid ${color}`,
          }}
        />
        {autoOn ? 'AUTO' : 'MAN'}
      </div>
    </div>
  );
}

// ── A: Corner clusters ───────────────────────────────────────────────────────

function ClusterA({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const look = useFireLook();
  const color = fireLookColor(look);
  const FIRE = 80;
  const BOOST = 54;
  return (
    <div
      style={{
        position: 'fixed',
        right: `calc(env(safe-area-inset-right, 0px) + ${THUMB_INSET}px)`,
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${THUMB_INSET}px)`,
        width: FIRE,
        height: FIRE,
        zIndex: 16,
        pointerEvents: 'none',
      }}
    >
      <HoldButton
        testId="hud-fire"
        size={FIRE}
        color={color}
        filled={look === 'engaged' || look === 'manual'}
        dataState={look}
        onHold={(d) => touchInput.setFireHeld(d)}
      >
        <AutoPip size={FIRE} look={look} />
        <CooldownRing size={FIRE + 10} color={color} />
        <span style={{ fontSize: 11 }}>{look === 'manual' ? 'FIRE' : look === 'off' ? 'FIRE' : 'AUTO'}</span>
      </HoldButton>
      <ModePill style={{ right: FIRE - 10, top: -28 }} />
      <div style={{ position: 'absolute', right: FIRE + 14, bottom: 6 }}>
        <HoldButton testId="hud-boost" size={BOOST} color={HUD.color.boost} onHold={(d) => touchInput.setBoostHeld(d)}>
          BOOST
        </HoldButton>
      </div>
      <div style={{ position: 'absolute', right: 6, bottom: FIRE + 18 }}>
        <HoldButton testId="hud-slot" size={30} color={HUD.color.inkDim} onTap={cycleSlot}>
          <span style={{ fontSize: 8 }}>WPN</span>
        </HoldButton>
      </div>
    </div>
  );
}

// ── B: Twin-stick ────────────────────────────────────────────────────────────

function ClusterB({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const look = useFireLook();
  const color = look === 'manual' ? HUD.color.manual : HUD.color.auto;
  const onMove = useCallback((v: StickVec) => aimInput.setStick(v.x, v.y), []);
  const onEnd = useCallback(() => aimInput.clear(), []);
  const R = 50;
  return (
    <>
      <FloatingStick
        id="hud-aim"
        zone={{ right: 0, top: '28%', width: '44%', bottom: 0 }}
        home={{ right: THUMB_INSET, bottom: THUMB_INSET }}
        radius={R}
        knob={42}
        color={color}
        onMove={onMove}
        onEnd={onEnd}
        ring={<><AutoPip size={R * 2} look={look} /><CooldownRing size={R * 2 + 10} color={color} /></>}
        idleOpacity={0.55}
        zIndex={16}
      >
        <span style={{ fontFamily: HUD.font.label, fontWeight: 700, fontSize: 8.5, letterSpacing: 1, color: '#fff' }}>
          {look === 'manual' ? 'FIRE' : 'AIM'}
        </span>
      </FloatingStick>
      <div
        style={{
          position: 'fixed',
          right: `calc(env(safe-area-inset-right, 0px) + ${THUMB_INSET + R - 22}px)`,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${THUMB_INSET + R * 2 + 16}px)`,
          zIndex: 17,
          pointerEvents: 'none',
        }}
      >
        <HoldButton testId="hud-boost" size={44} color={HUD.color.boost} onHold={(d) => touchInput.setBoostHeld(d)}>
          <span style={{ fontSize: 8 }}>BOOST</span>
        </HoldButton>
        <ModePill style={{ right: 56, top: 14 }} />
      </div>
    </>
  );
}

// ── C: Smart attack button ───────────────────────────────────────────────────

function ClusterC({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const look = useFireLook();
  const color = fireLookColor(look === 'off' ? 'manual' : look);
  const onMove = useCallback((v: StickVec) => {
    if (v.mag > 0.3) aimInput.setStick(v.x, v.y);
    else aimInput.clear();
  }, []);
  const onEnd = useCallback(
    (tapped: boolean) => {
      aimInput.clear();
      if (tapped) {
        // Tap = a burst at whatever the turrets have locked.
        touchInput.setFireHeld(true);
        window.setTimeout(() => touchInput.setFireHeld(false), 240);
      }
    },
    [touchInput],
  );
  const R = 44;
  const base = THUMB_INSET + 6;
  return (
    <>
      <FloatingStick
        id="hud-attack"
        floating={false}
        zone={{}}
        home={{ right: base, bottom: base }}
        radius={R}
        knob={48}
        color={color}
        leash={false}
        onMove={onMove}
        onEnd={onEnd}
        idleOpacity={0.85}
        ring={<><AutoPip size={R * 2} look={look} /><CooldownRing size={R * 2 + 10} color={color} /></>}
        zIndex={16}
      >
        <svg width={20} height={20} viewBox="0 0 20 20" style={{ opacity: 0.95 }}>
          <circle cx={10} cy={10} r={6} fill="none" stroke="#fff" strokeWidth={1.6} />
          <path d="M10 1v5M10 14v5M1 10h5M14 10h5" stroke="#fff" strokeWidth={1.6} />
        </svg>
      </FloatingStick>
      {/* Satellites on an arc up-left of the attack button. */}
      <div
        style={{
          position: 'fixed',
          right: `calc(env(safe-area-inset-right, 0px) + ${base}px)`,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${base}px)`,
          width: R * 2,
          height: R * 2,
          zIndex: 17,
          pointerEvents: 'none',
        }}
      >
        <div style={{ position: 'absolute', right: R * 2 + 12, bottom: 2 }}>
          <HoldButton testId="hud-boost" size={50} color={HUD.color.boost} onHold={(d) => touchInput.setBoostHeld(d)}>
            BOOST
          </HoldButton>
        </div>
        <div style={{ position: 'absolute', right: R * 2 - 6, bottom: R * 2 + 4 }}>
          <HoldButton testId="hud-slot" size={34} color={HUD.color.inkDim} onTap={cycleSlot}>
            <span style={{ fontSize: 8 }}>WPN</span>
          </HoldButton>
        </div>
        <ModePill style={{ right: -4, bottom: R * 2 + 14 }} />
      </div>
    </>
  );
}

// ── Desktop fire chip ────────────────────────────────────────────────────────

function DesktopFireChip({ scale }: { scale: number }): JSX.Element {
  const look = useFireLook();
  const autoOn = useUIStore((s) => s.autoFireEnabled);
  const toggle = useAutoToggle();
  const color = fireLookColor(look);
  const fs = Math.round(9 * scale);
  return (
    <div
      data-testid="hud-auto-toggle"
      data-state={autoOn ? 'on' : 'off'}
      data-hud-exclusion=""
      onClick={toggle}
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 3,
        fontFamily: HUD.font.label,
        userSelect: 'none',
      }}
    >
      <div
        data-testid="hud-fire"
        data-state={look}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 4,
          border: `1px solid ${color}`,
          color,
          background: look === 'engaged' || look === 'manual' ? `${color}22` : 'rgba(6,10,20,.55)',
          fontWeight: 700,
          fontSize: fs + 1,
          letterSpacing: 1.5,
          boxShadow: look === 'engaged' || look === 'manual' ? `0 0 12px ${color}55` : 'none',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, opacity: look === 'auto' || look === 'off' ? 0.35 : 1 }} />
        {look === 'manual' ? 'MANUAL AIM' : look === 'engaged' ? 'AUTO · ENGAGED' : autoOn ? 'AUTO · ARMED' : 'AUTO OFF'}
      </div>
      <div style={{ fontSize: fs - 1, color: HUD.color.inkFaint, letterSpacing: 0.6 }}>
        HOLD <b style={{ color: HUD.color.inkDim }}>LMB</b> aim+fire · <b style={{ color: HUD.color.inkDim }}>RMB</b> boost · <b style={{ color: HUD.color.inkDim }}>F</b> auto
      </div>
    </div>
  );
}

// ── D: Fire Control ──────────────────────────────────────────────────────────

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
 * Right thumb: smart-aim lock. Drag anywhere in the right zone — a guideline
 * leaves the ship along the drag; the lockable target nearest it lights up;
 * release starts the lock for the active group. A tap does nothing (taps
 * select entities, and the inspector's Target button locks the selection).
 */
function ClusterD({ touchInput }: { touchInput: TouchInput }): JSX.Element {
  const onMove = useCallback((v: StickVec) => {
    getGameClient()?.updateLockGuide(v.mag > 0.25 ? stickToWorldBearing(v.x, v.y) : NaN);
  }, []);
  const onEnd = useCallback((tapped: boolean) => {
    const c = getGameClient();
    if (tapped) c?.updateLockGuide(NaN);
    else c?.commitLockGuide();
  }, []);
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
      <div>{k('DRAG LMB')} lock · {k('T')} lock selected · {k('X')} clear</div>
      <div>{k('1–9')} group · {k('SHIFT+1–9')} auto/man · {k('RMB')} boost</div>
    </div>
  );
}
