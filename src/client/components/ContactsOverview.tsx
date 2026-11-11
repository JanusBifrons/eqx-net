/**
 * Contacts overview: an EVE-style list of what you can lock, for picking far
 * targets without zooming out (owner, 2026-11-10: "lock and pick targets like
 * you do in Eve where you're reduced to a list view like you use when you warp
 * to"). Rows: kind icon, name, distance, reach, lock state, locking-you.
 *
 * Tap a row: lock it with the ACTIVE weapon group (the same `lock_request`
 * the info box's LOCK and the T key send). Tap a row the active group is
 * already locking or has locked: cancel (`lock_cancel`, like CANCEL / UNLOCK).
 * The server still checks reach and the lock rules (#15, #19).
 *
 * Placement: a dock on the LEFT edge, just below the top band (top 30%), the
 * mirror of the weapon strip on the right edge. The toggle tab is always
 * there; the list opens under it, capped so it ends well above the move
 * stick's home (bottom-left) on a phone. It sits above the floating-stick
 * zones (z 18, like the weapon strip dock), so its rows take taps; closed, it
 * costs only the tab.
 *
 * Data: the render mirror polled at 4 Hz while open (the TeleporterPanel /
 * warp picker pattern), re-rendering only when what's shown changes. Only the
 * open flag lives in Zustand (#2).
 */
import { memo, useEffect, useState } from 'react';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { ENTITY_VISUALS, entityBadgePolygon, type EntityKind } from '../render/entityVisuals';
import { FAILSAFE_COLOUR, THREAT_COLOUR_HEX, groupColourHex } from '../hud/groupColours';
import { HUD } from '../hud/tokens';
import { isTouchDevice } from '../input/TouchInput';
import {
  buildContactRows, contactTapAction, contactsSignature, formatContactKm, sortContacts,
  type ContactRow, type GroupReach,
} from './contactRows';

const POLL_MS = 250;
const FAILSAFE_HEX = `#${FAILSAFE_COLOUR.toString(16)}`;

const DOCK_STYLE = {
  position: 'fixed' as const,
  left: 'calc(env(safe-area-inset-left, 0px) + 10px)',
  top: '30%',
  zIndex: 18,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: 4,
  pointerEvents: 'none' as const,
};
const TAB_STYLE = {
  pointerEvents: 'auto' as const,
  cursor: 'pointer',
  padding: '2px 7px',
  borderRadius: 4,
  fontFamily: HUD.font.label,
  fontWeight: 700,
  fontSize: 9,
  letterSpacing: 1,
  color: HUD.color.ink,
  background: HUD.color.panel,
  border: `1px solid ${HUD.color.panelEdge}`,
  touchAction: 'manipulation' as const,
};
const PANEL_STYLE = {
  pointerEvents: 'auto' as const,
  width: 210,
  // Ends ≥ ~150 px above the bottom edge: clear of the move stick's home.
  maxHeight: 'min(360px, calc(70dvh - 154px))',
  overflowY: 'auto' as const,
  background: 'rgba(6,10,20,0.86)',
  border: `1px solid ${HUD.color.panelEdge}`,
  borderRadius: 4,
  padding: 3,
  fontFamily: HUD.font.label,
  color: HUD.color.ink,
};
const HEAD_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, padding: '0 2px 2px', fontSize: 8, color: HUD.color.inkDim, letterSpacing: 0.8 };
const SORT_STYLE = { cursor: 'pointer', fontSize: 8, padding: '0 4px', background: 'transparent', color: HUD.color.inkDim, border: `1px solid ${HUD.color.panelEdge}`, borderRadius: 3, fontFamily: HUD.font.label };
const ROW_STYLE = {
  display: 'flex', alignItems: 'center', gap: 4, width: '100%', minHeight: 20, padding: '1px 3px', border: 'none', borderRadius: 3,
  background: 'transparent', color: HUD.color.ink, fontFamily: HUD.font.label, fontSize: 10, textAlign: 'left' as const, cursor: 'pointer',
};
const NAME_STYLE = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const };
const DIST_STYLE = { flex: '0 0 auto', fontFamily: HUD.font.num, fontSize: 9, color: HUD.color.inkDim, minWidth: 38, textAlign: 'right' as const };
const LOCK_STYLE = { flex: '0 0 36px', fontFamily: HUD.font.num, fontSize: 8, fontWeight: 700, textAlign: 'right' as const };
const EMPTY_STYLE = { fontSize: 9, color: HUD.color.inkFaint, padding: '4px 3px' };

function stopPointer(e: { stopPropagation(): void }): void {
  e.stopPropagation();
}

/** The kind icon: the shared visual-language shape, no count. */
function KindIcon({ kind }: { kind: EntityKind }): JSX.Element {
  const v = ENTITY_VISUALS[kind];
  const pts = entityBadgePolygon(v.shape, 4.5);
  let points = '';
  for (let i = 0; i < pts.length; i += 2) points += `${pts[i]},${pts[i + 1]} `;
  return (
    <svg width={10} height={10} viewBox="-5 -5 10 10" style={{ flex: '0 0 auto', display: 'block' }} aria-hidden>
      <polygon points={points.trim()} fill={v.cssColor} />
    </svg>
  );
}

interface View { rows: ContactRow[]; sig: string }

function poll(activeGroupId: string | null, groupIds: ReadonlyArray<string>, hostilesFirst: boolean): View {
  const c = getGameClient();
  if (!c) return { rows: [], sig: '' };
  const reaches: GroupReach[] = groupIds.map((id) => ({ id, reach: c.fcGroupReach(id) }));
  const rows = sortContacts(buildContactRows(c.mirror, activeGroupId, reaches), hostilesFirst);
  return { rows, sig: contactsSignature(rows) };
}

export const ContactsOverview = memo(function ContactsOverview(): JSX.Element {
  const open = useUIStore((s) => s.contactsOpen);
  const setOpen = useUIStore((s) => s.setContactsOpen);
  const groups = useUIStore((s) => s.fcGroups);
  const activeGroupId = useUIStore((s) => s.activeGroupId);
  const [hostilesFirst, setHostilesFirst] = useState(true);
  const [view, setView] = useState<View>({ rows: [], sig: '' });
  const touch = isTouchDevice();

  useEffect(() => {
    if (!open) return undefined;
    const ids = groups.map((g) => g.id);
    const tick = (): void => {
      const next = poll(activeGroupId, ids, hostilesFirst);
      setView((prev) => (prev.sig === next.sig ? prev : next));
    };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(h);
  }, [open, groups, activeGroupId, hostilesFirst]);

  const activeIdx = groups.findIndex((g) => g.id === activeGroupId);
  const activeName = activeIdx >= 0 ? groups[activeIdx]!.name : '';

  const onRow = (r: ContactRow): void => {
    const c = getGameClient();
    if (!c || !activeGroupId) return;
    if (contactTapAction(r) === 'cancel') c.cancelLock(activeGroupId, r.key);
    else c.requestLock(activeGroupId, r.key);
  };

  return (
    <div style={DOCK_STYLE} data-hud-exclusion="" onPointerDown={stopPointer} data-testid="contacts-dock">
      <button
        type="button"
        style={TAB_STYLE}
        data-testid="contacts-toggle"
        aria-pressed={open}
        aria-keyshortcuts="O"
        title={touch ? undefined : 'Contacts (O key)'}
        onClick={() => setOpen(!open)}
      >
        {/* No count and no "(O)" hotkey hint in the label: "(O)" read as a
            zero count while closed. The shortcut lives in the tooltip. */}
        {open ? '◂ CONTACTS' : 'CONTACTS ▸'}
      </button>
      {open && (
        <div style={PANEL_STYLE} data-testid="contacts-panel" data-count={view.rows.length}>
          <div style={HEAD_STYLE}>
            <span>
              {activeName ? <>TAP TO LOCK · <span style={{ color: groupColourHex(activeIdx) }}>{activeName.toUpperCase()}</span></> : 'NO WEAPON GROUP'}
            </span>
            <button type="button" style={SORT_STYLE} data-testid="contacts-sort" aria-pressed={hostilesFirst} onClick={() => setHostilesFirst(!hostilesFirst)}>
              {hostilesFirst ? 'HOSTILE ▴' : 'NEAREST'}
            </button>
          </div>
          {view.rows.length === 0 && <div style={EMPTY_STYLE}>Nothing to lock nearby</div>}
          {view.rows.map((r) => <Row key={r.key} r={r} groups={groups} activeIdx={activeIdx} onTap={onRow} />)}
        </div>
      )}
    </div>
  );
});

function Row({ r, groups, activeIdx, onTap }: {
  r: ContactRow;
  groups: ReadonlyArray<{ id: string }>;
  activeIdx: number;
  onTap: (r: ContactRow) => void;
}): JSX.Element {
  const lock = r.lock;
  const lockIdx = lock ? groups.findIndex((g) => g.id === lock.groupId) : -1;
  const lockCol = lock ? (lock.stage === 0 ? FAILSAFE_HEX : groupColourHex(lockIdx)) : undefined;
  const reachCol = activeIdx >= 0 ? groupColourHex(activeIdx) : HUD.color.inkDim;
  const reachMark = r.inActiveReach ? '●' : r.inAnyReach ? '○' : '·';
  const reachTitle = r.inActiveReach ? 'in reach of the active group' : r.inAnyReach ? 'in reach of another group' : 'out of reach';
  const lockState = lock === null ? 'none' : lock.stage === 2 ? 'locked' : 'acquiring';
  return (
    <button
      type="button"
      style={{ ...ROW_STYLE, opacity: r.inAnyReach ? 1 : 0.6, background: r.activeLock ? 'rgba(255,255,255,0.06)' : 'transparent' }}
      onClick={() => onTap(r)}
      data-testid={`contact-row-${r.key}`}
      data-key={r.key}
      data-kind={r.icon}
      data-lock={lockState}
      data-lock-group={lock?.groupId ?? ''}
      data-in-reach={r.inActiveReach ? 'active' : r.inAnyReach ? 'any' : 'none'}
      data-locking-you={r.lockingYou}
    >
      <KindIcon kind={r.icon} />
      <span style={NAME_STYLE}>{r.name}</span>
      {r.lockingYou > 0 && (
        <span title={r.lockingYou === 2 ? 'has you locked' : 'locking you'} style={{ color: THREAT_COLOUR_HEX, fontSize: 9, fontWeight: 700 }}>
          {r.lockingYou === 2 ? '⚠' : '◎'}
        </span>
      )}
      <span title={reachTitle} style={{ color: r.inActiveReach ? reachCol : HUD.color.inkDim, fontSize: 9 }}>{reachMark}</span>
      <span style={DIST_STYLE}>{formatContactKm(r.dist)}</span>
      <span style={{ ...LOCK_STYLE, color: lockCol }}>{lock === null ? '' : lock.stage === 2 ? 'LOCKED' : `${lock.pct}%`}</span>
    </button>
  );
}
