/**
 * Shared experimental-HUD widgets (exp/hud-mobile-first): hold/tap buttons
 * with oversized touch areas, the cooldown ring, the sector chip, status
 * bars, and the fake-credits demo drip.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { getWeapon } from '../../core/combat/WeaponCatalogue';
import { getShipKind } from '@shared-types/shipKinds';
import { resolveSlotMounts } from '@shared-types/shipKinds/slots';
import { HUD, hullColor } from './tokens';

// ── HoldButton ──────────────────────────────────────────────────────────────

export interface HoldButtonProps {
  testId: string;
  /** Visual diameter (px). The touch area is at least HUD.touchMin. */
  size: number;
  color: string;
  /** Held controls (fire / boost). */
  onHold?: (down: boolean) => void;
  /** Tap controls (toggles). Fires on pointer-down for snappy multitouch. */
  onTap?: () => void;
  children?: ReactNode;
  filled?: boolean;
  style?: CSSProperties;
  title?: string;
  dataState?: string;
}

/**
 * A round control whose invisible hit area is at least 44 px even when the
 * visual is 24 px. Pointer events (not click), so it works as a second
 * finger while the other thumb steers.
 */
export function HoldButton(p: HoldButtonProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const slop = Math.max(0, (HUD.touchMin - p.size) / 2) + 4;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let id: number | null = null;
    const down = (e: PointerEvent): void => {
      if (id !== null) return;
      id = e.pointerId;
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      el.dataset.pressed = '1';
      cb.current.onHold?.(true);
      cb.current.onTap?.();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = null;
      el.dataset.pressed = '0';
      cb.current.onHold?.(false);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      if (id !== null) cb.current.onHold?.(false);
    };
  }, []);

  return (
    <div
      ref={ref}
      role="button"
      title={p.title}
      data-testid={p.testId}
      data-state={p.dataState}
      data-hud-exclusion=""
      className="eqx-holdbtn"
      style={{
        position: 'relative',
        width: p.size,
        height: p.size,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor: 'pointer',
        pointerEvents: 'auto',
        color: p.color,
        border: `1.5px solid ${p.color}`,
        background: p.filled ? `${p.color}33` : 'rgba(6,10,20,0.45)',
        boxShadow: p.filled ? `0 0 14px ${p.color}66, inset 0 0 10px ${p.color}33` : `0 0 8px ${p.color}22`,
        fontFamily: HUD.font.label,
        fontWeight: 700,
        letterSpacing: 1,
        fontSize: Math.max(8, Math.round(p.size * 0.17)),
        textTransform: 'uppercase',
        transition: 'background 120ms, box-shadow 120ms, color 120ms, border-color 120ms',
        ...p.style,
        // Invisible oversize hit area.
        ['--slop' as string]: `${slop}px`,
      }}
    >
      {p.children}
    </div>
  );
}

// ── CooldownRing (live ship) ─────────────────────────────────────────────────

function liveSlotCooldownMs(slotId: string): number {
  const c = getGameClient();
  const id = c?.mirror.localPlayerId;
  const kind = id ? c?.mirror.ships.get(id)?.kind : undefined;
  if (!kind) return 0;
  const mounts = resolveSlotMounts(getShipKind(kind), slotId);
  let ticks = 0;
  for (let i = 0; i < mounts.length; i++) {
    const t = getWeapon(mounts[i]!.weaponId).cooldownTicks;
    if (t > ticks) ticks = t;
  }
  return (ticks * 1000) / 60;
}

/** Draining ring around a control: full at fire, empty when ready. Reads the
 *  LIVE ship's slot cooldown (the legacy ring read the next-spawn pick). */
export function CooldownRing({ size, color }: { size: number; color: string }): JSX.Element {
  const lastFireMs = useUIStore((s) => s.lastFireMs);
  const activeSlotId = useUIStore((s) => s.activeSlotId);
  const ref = useRef<SVGCircleElement | null>(null);
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;

  useEffect(() => {
    const el = ref.current;
    if (!el || lastFireMs === null) return;
    const cd = liveSlotCooldownMs(activeSlotId);
    if (cd <= 0) return;
    let raf = 0;
    const tick = (): void => {
      const rem = Math.max(0, 1 - (performance.now() - lastFireMs) / cd);
      el.style.strokeDashoffset = String(circ * (1 - rem));
      el.style.opacity = rem > 0.01 ? '1' : '0';
      if (rem > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lastFireMs, activeSlotId, circ]);

  return (
    <svg
      width={size}
      height={size}
      style={{ position: 'absolute', left: '50%', top: '50%', marginLeft: -size / 2, marginTop: -size / 2, pointerEvents: 'none' }}
    >
      <circle
        ref={ref}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ opacity: 0, transition: 'opacity 120ms linear' }}
      />
    </svg>
  );
}

// ── Fire-mode state ──────────────────────────────────────────────────────────

export type FireLook = 'manual' | 'engaged' | 'auto' | 'off';

/**
 * One answer to "what is my gun doing?" for every variant:
 *  - manual  : you are aiming / holding fire (amber)
 *  - engaged : auto is firing at a locked target (bright cyan, spinning pip)
 *  - auto    : auto is armed, nothing in range (dim cyan)
 *  - off     : auto disabled, not firing (grey)
 */
export function useFireLook(): FireLook {
  const autoOn = useUIStore((s) => s.autoFireEnabled);
  const aimMode = useUIStore((s) => s.aimMode);
  const engaged = useUIStore((s) => s.autoEngaged);
  if (aimMode === 'manual') return 'manual';
  if (!autoOn) return 'off';
  return engaged ? 'engaged' : 'auto';
}

export function fireLookColor(l: FireLook): string {
  if (l === 'manual') return HUD.color.manual;
  if (l === 'off') return 'rgba(170,180,195,0.75)';
  return HUD.color.auto;
}

/** Small orbiting pip that spins while auto is engaged. */
export function AutoPip({ size, look }: { size: number; look: FireLook }): JSX.Element | null {
  if (look !== 'engaged' && look !== 'auto') return null;
  return (
    <div
      className={look === 'engaged' ? 'eqx-pip-spin' : undefined}
      style={{
        position: 'absolute',
        inset: -5,
        borderRadius: '50%',
        border: `2px solid transparent`,
        borderTopColor: HUD.color.auto,
        opacity: look === 'engaged' ? 1 : 0.35,
        pointerEvents: 'none',
        width: size + 10,
        height: size + 10,
      }}
    />
  );
}

// ── SectorChip ───────────────────────────────────────────────────────────────

const GRID_CELL = 500;

/** One-line sector readout ("Sol Prime · Roman · 3,-2"); tap to expand. */
export function SectorChip({ size = 9 }: { size?: number }): JSX.Element {
  const sectorName = useUIStore((s) => s.sectorName);
  const sectorKey = useUIStore((s) => s.currentSectorKey);
  const [open, setOpen] = useState(false);
  const gridRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let last = '';
    const tick = (): void => {
      const c = getGameClient();
      const id = c?.mirror.localPlayerId;
      const ship = id ? c?.mirror.ships.get(id) : null;
      const s = ship ? `${Math.round(ship.x / GRID_CELL)},${Math.round(ship.y / GRID_CELL)}` : '—';
      if (s !== last && gridRef.current) {
        last = s;
        gridRef.current.textContent = s;
      }
    };
    tick();
    const h = window.setInterval(tick, 250);
    return () => window.clearInterval(h);
  }, []);

  const name = sectorName !== '' ? sectorName : sectorKey === null ? 'Test arena' : '—';
  return (
    <div
      data-testid="hud-sector"
      data-hud-exclusion=""
      onPointerDown={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        fontFamily: HUD.font.label,
        fontSize: size,
        color: HUD.color.inkDim,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        padding: '6px 4px', // fattens the tap target without visual weight
        margin: '-6px -4px',
        lineHeight: 1.25,
      }}
    >
      <span style={{ color: HUD.color.ink, fontWeight: 600 }}>{name}</span>
      <span style={{ opacity: 0.5 }}> · </span>
      <span ref={gridRef} style={{ fontFamily: HUD.font.num }} />
      {open && (
        <div style={{ marginTop: 3, fontSize: size - 1, color: HUD.color.inkFaint, lineHeight: 1.4 }}>
          <div>Sovereignty <span style={{ color: HUD.color.inkDim }}>Roman</span></div>
          <div>Region <span style={{ color: HUD.color.inkDim }}>Sol</span></div>
        </div>
      )}
    </div>
  );
}

// ── Status bars ──────────────────────────────────────────────────────────────

/** Drives an energy fill element's scaleX from the predicted pool (RAF, no
 *  React renders). Attach the returned ref to the fill element. */
export function useEnergyFill(): React.MutableRefObject<HTMLDivElement | null> {
  const energyMax = useUIStore((s) => s.energyMax);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const max = energyMax > 0 ? energyMax : 1;
    let lastPct = -1;
    const tick = (): void => {
      const e = getGameClient()?.getPredictedEnergy() ?? 0;
      const pct = Math.max(0, Math.min(1, e / max));
      const el = ref.current;
      if (el) {
        el.style.transform = `scaleX(${pct})`;
        const pi = Math.round(pct * 100);
        if (pi !== lastPct) {
          lastPct = pi;
          el.dataset.energyPct = String(pi);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [energyMax]);
  return ref;
}

interface BarProps {
  label: string;
  color: string;
  pct?: number;
  width: number;
  height: number;
  fillRef?: React.MutableRefObject<HTMLDivElement | null>;
  testId: string;
  labelSize: number;
}

export function ThinBar({ label, color, pct, width, height, fillRef, testId, labelSize }: BarProps): JSX.Element {
  return (
    <div data-testid={testId} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: labelSize * 3.2,
          fontFamily: HUD.font.label,
          fontSize: labelSize,
          letterSpacing: 0.8,
          color: HUD.color.inkFaint,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <div
        style={{
          width,
          height,
          background: 'rgba(255,255,255,0.10)',
          borderRadius: height,
          overflow: 'hidden',
          boxShadow: `0 0 6px ${color}33`,
        }}
      >
        <div
          ref={fillRef}
          style={{
            width: '100%',
            height: '100%',
            background: color,
            transformOrigin: 'left center',
            transform: pct === undefined ? undefined : `scaleX(${Math.max(0, Math.min(1, pct / 100))})`,
            transition: pct === undefined ? undefined : 'transform 900ms ease-out, background 300ms',
            willChange: 'transform',
          }}
        />
      </div>
    </div>
  );
}

/** Shield / hull / energy as three hairline bars (variant A). */
export function StatusStack({ scale }: { scale: number }): JSX.Element {
  const shield = useUIStore((s) => s.shieldPct);
  const hull = useUIStore((s) => s.hullPct);
  const energyRef = useEnergyFill();
  const w = Math.round(84 * scale);
  const h = Math.max(3, Math.round(3 * scale));
  const ls = Math.round(7.5 * scale);
  return (
    <div data-testid="hud-status" data-hud-exclusion="" style={{ display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none' }}>
      <ThinBar testId="hud-shield" label="SHD" color={HUD.color.shield} pct={shield} width={w} height={h} labelSize={ls} />
      <ThinBar testId="hud-hull" label="HUL" color={hullColor(hull)} pct={hull} width={w} height={h} labelSize={ls} />
      <ThinBar testId="hud-energy" label="NRG" color={HUD.color.energy} fillRef={energyRef} width={w} height={h} labelSize={ls} />
    </div>
  );
}

// ── Fake credits (demo only) ─────────────────────────────────────────────────

/** `?fakeCredits=1`: drip wallet changes so the counter animation can be
 *  seen/filmed without a kill or trade. Dev/demo only. */
export function useFakeCredits(): void {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('fakeCredits') !== '1') return;
    const st = useUIStore.getState();
    if (st.wallet === null) st.setWallet(12450);
    const h = window.setInterval(() => {
      const s = useUIStore.getState();
      const cur = s.wallet ?? 12450;
      const r = Math.random();
      const delta = r < 0.2 ? -Math.round(40 + Math.random() * 160) : Math.round(60 + Math.random() * 900);
      s.setWallet(Math.max(0, cur + delta));
    }, 3200);
    return () => window.clearInterval(h);
  }, []);
}
