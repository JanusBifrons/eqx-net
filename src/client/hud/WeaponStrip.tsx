/**
 * Fire Control weapon strip (exp/fire-control, `?ui=d`). A vertical column of
 * chips on the right edge, one per weapon group, each in its group colour —
 * the same colour as that group's lock brackets and firing lines in the world.
 *
 *  - Tap a chip: make it the active group (the one new locks go to).
 *  - AUTO/MAN pill: toggle the group's fire mode (server-authoritative).
 *  - MAN groups: hold the chip to fire that group at its lock.
 *  - × (shown while a group holds locks): drop that group's locks.
 *
 * Reads only discrete Zustand state (`fcGroups`, `activeGroupId`) — never
 * spatial data (invariant #2). Visual is small; hit areas are oversized.
 */
import { useEffect, useRef } from 'react';
import { useUIStore } from '../state/store';
import type { FcGroupSummary } from '../state/storeTypes';
import { getGameClient } from '../net/clientSingleton';
import { FAILSAFE_COLOUR, groupColourHex } from './groupColours';

const FAILSAFE_HEX = `#${FAILSAFE_COLOUR.toString(16)}`;
import { HUD } from './tokens';

const CHIP_W = 58;
const CHIP_H = 30;

export function WeaponStrip({ scale = 1 }: { scale?: number }): JSX.Element | null {
  const groups = useUIStore((s) => s.fcGroups);
  const active = useUIStore((s) => s.activeGroupId);
  if (groups.length === 0) return null;
  return (
    <div
      data-testid="fc-strip"
      data-hud-exclusion=""
      style={{ display: 'flex', flexDirection: 'column', gap: 10 * scale, pointerEvents: 'auto' }}
    >
      {groups.map((g, i) => (
        <Chip key={g.id} group={g} index={i} active={g.id === active} scale={scale} />
      ))}
    </div>
  );
}

function stop(e: { preventDefault(): void; stopPropagation(): void }): void {
  e.preventDefault();
  e.stopPropagation();
}

function Chip({ group, index, active, scale }: { group: FcGroupSummary; index: number; active: boolean; scale: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const g = useRef(group);
  g.current = group;
  const col = groupColourHex(index);
  const locked = group.locks.filter((l) => l.stage === 2).length;
  const acquiring = group.locks.length - locked;
  const manual = group.mode === 'manual';

  // Lock progress bar: polled from the render mirror at 10 Hz, written to the
  // DOM directly (no React render per percent).
  const bar = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const h = window.setInterval(() => {
      const el = bar.current;
      const grp = getGameClient()?.mirror.localGroups?.[index];
      if (!el) return;
      let pct = 0;
      let failsafe = false;
      if (grp) for (const l of grp.l) if (l.s !== 2 && l.p >= pct) { pct = l.p; failsafe = l.s === 0; }
      el.style.width = `${pct}%`;
      el.style.background = failsafe ? FAILSAFE_HEX : HUD.color.danger;
      el.parentElement!.style.opacity = pct > 0 ? '1' : '0';
    }, 100);
    return () => window.clearInterval(h);
  }, [index]);

  // Pointer handling on the chip body: select; MAN groups fire while held.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let id: number | null = null;
    const down = (e: PointerEvent): void => {
      if (id !== null) return;
      id = e.pointerId;
      stop(e);
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      useUIStore.getState().setActiveGroupId(g.current.id);
      if (g.current.mode === 'manual') getGameClient()?.setGroupHeld(g.current.id);
      el.dataset.pressed = '1';
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = null;
      getGameClient()?.setGroupHeld(null);
      delete el.dataset.pressed;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, []);

  const w = CHIP_W * scale;
  const h = CHIP_H * scale;
  const fs = Math.max(8, Math.round(9 * scale));
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      {group.locks.length > 0 && (
        <div
          data-testid={`fc-clear-${group.id}`}
          onPointerDown={(e) => { stop(e); getGameClient()?.cancelLock(group.id); }}
          style={{ padding: 10, margin: -10, cursor: 'pointer', touchAction: 'none' }}
        >
          <div style={{ width: 16, height: 16, borderRadius: 8, border: `1px solid ${HUD.color.inkFaint}`, color: HUD.color.inkDim, fontSize: 10, lineHeight: '14px', textAlign: 'center', background: HUD.color.panel }}>×</div>
        </div>
      )}
      <div
        ref={ref}
        data-testid={`fc-chip-${group.id}`}
        data-active={active ? '1' : '0'}
        data-mode={group.mode}
        data-locked={locked}
        data-acquiring={acquiring}
        style={{
          position: 'relative',
          width: w,
          height: h,
          padding: '0 6px',
          boxSizing: 'border-box',
          borderRadius: 4,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 3,
          cursor: 'pointer',
          touchAction: 'none',
          userSelect: 'none',
          fontFamily: HUD.font.label,
          color: HUD.color.ink,
          background: active ? `${col}26` : HUD.color.panel,
          borderStyle: 'solid',
          borderColor: active ? col : `${col}66`,
          borderWidth: '1px 1px 1px 3px',
          borderLeftColor: col,
          boxShadow: active ? `0 0 10px ${col}55` : 'none',
          outline: '12px solid transparent', // oversized touch area
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: fs, fontWeight: 700, letterSpacing: 1 }}>
          <span>{group.name.toUpperCase()}</span>
          <span style={{ fontFamily: HUD.font.num, fontSize: fs - 1, color: HUD.color.inkFaint }}>{index + 1}</span>
        </div>
        <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgba(255,255,255,.12)', opacity: 0, transition: 'opacity .15s' }}>
          <span ref={bar} data-testid={`fc-progress-${group.id}`} style={{ display: 'block', height: '100%', width: 0 }} />
        </span>
        <div style={{ display: 'flex', gap: 3 }}>
          {Array.from({ length: group.capacity }, (_, k) => (
            <span
              key={k}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                border: `1px solid ${col}`,
                background: k < locked ? col : 'transparent',
                opacity: k < locked ? 1 : k < locked + acquiring ? 0.9 : 0.4,
                boxShadow: k >= locked && k < locked + acquiring ? `0 0 4px ${HUD.color.danger}` : 'none',
              }}
            />
          ))}
        </div>
      </div>
      <div
        data-testid={`fc-mode-${group.id}`}
        data-state={group.mode}
        onPointerDown={(e) => { stop(e); getGameClient()?.setGroupMode(group.id, manual ? 'auto' : 'manual'); }}
        style={{ position: 'absolute', right: -6, top: -9, padding: 8, margin: -8, cursor: 'pointer', touchAction: 'none' }}
      >
        <div
          style={{
            height: 11,
            padding: '0 4px',
            borderRadius: 6,
            fontFamily: HUD.font.label,
            fontSize: 7,
            fontWeight: 700,
            letterSpacing: 0.8,
            lineHeight: '10px',
            color: manual ? HUD.color.manual : HUD.color.auto,
            border: `1px solid ${manual ? HUD.color.manual : HUD.color.auto}`,
            background: 'rgba(6,10,20,.85)',
          }}
        >
          {manual ? 'MAN' : 'AUTO'}
        </div>
      </div>
    </div>
  );
}
