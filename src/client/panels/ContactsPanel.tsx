/**
 * The Contacts right panel (UI language plan A4, job U2-3): an EVE-style list
 * of what you can lock, for picking far targets without zooming out (owner,
 * 2026-11-10: "lock and pick targets like you do in Eve where you're reduced
 * to a list view like you use when you warp to"). Rows: kind icon, name,
 * locking-you, reach, distance, lock state.
 *
 * Opened by the rail's Contacts item (every control mode) or the O key
 * (`input/MouseLock.ts`): `rightPanel = 'contacts'`. ✕ and Esc clear the flag.
 *
 * Tap a row: lock it with the ACTIVE weapon group (the same `lock_request`
 * the info box's LOCK and the T key send). Tap a row the active group is
 * already locking or has locked: cancel (`lock_cancel`, like CANCEL / UNLOCK).
 * The server still checks reach and the lock rules (#15, #19).
 *
 * Data: the render mirror polled at 4 Hz while open (the TeleporterPanel /
 * warp picker pattern), re-rendering only when what's shown changes
 * (`contactsSignature`). Only the `rightPanel` flag lives in Zustand (#2).
 */
import { memo, useCallback, useEffect, useState, type CSSProperties } from 'react';
import { EQX_PANEL_SIZE, EqxListRow, EqxPanel, EqxSection, EqxSegmented } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { ENTITY_VISUALS, entityBadgePolygon, type EntityKind } from '../render/entityVisuals';
import { FAILSAFE_COLOUR, THREAT_COLOUR_HEX, groupColourHex } from '../hud/groupColours';
import { HUD } from '../hud/tokens';
import {
  buildContactRows, contactTapAction, contactsSignature, formatContactKm, sortContacts,
  type ContactRow, type GroupReach,
} from '../components/contactRows';

const POLL_MS = 250;
const FAILSAFE_HEX = `#${FAILSAFE_COLOUR.toString(16)}`;

/** The sort switch: hostiles first (the default), or nearest first. */
export const CONTACT_SORTS: readonly { id: 'hostile' | 'nearest'; label: string }[] = [
  { id: 'hostile', label: 'Hostile first' },
  { id: 'nearest', label: 'Nearest' },
];

const BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: HUD.panel.bodyGap, minWidth: 0 };
const SIDE_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const LOCK_STYLE: CSSProperties = { minWidth: 36, fontWeight: 700, textAlign: 'right' };
const THREAT_STYLE: CSSProperties = { color: THREAT_COLOUR_HEX, fontWeight: 700 };
const ICON_STYLE: CSSProperties = { display: 'block' };

/** The kind icon: the shared visual-language shape, no count. */
function KindIcon({ kind }: { kind: EntityKind }): JSX.Element {
  const v = ENTITY_VISUALS[kind];
  const pts = entityBadgePolygon(v.shape, 4.5);
  let points = '';
  for (let i = 0; i < pts.length; i += 2) points += `${pts[i]},${pts[i + 1]} `;
  return (
    <svg width={10} height={10} viewBox="-5 -5 10 10" style={ICON_STYLE} aria-hidden>
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

export const ContactsPanel = memo(function ContactsPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'contacts');
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const groups = useUIStore((s) => s.fcGroups);
  const activeGroupId = useUIStore((s) => s.activeGroupId);
  const [hostilesFirst, setHostilesFirst] = useState(true);
  const [view, setView] = useState<View>({ rows: [], sig: '' });
  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);

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
    <EqxPanel
      open={open}
      onClose={onClose}
      // The test id goes on the Paper: the persistent Drawer root is zero-size.
      testId="contacts-panel-root"
      paperAttrs={{ 'data-testid': 'contacts-panel', 'data-count': String(view.rows.length) }}
      closeTestId="contacts-panel-close"
      title="Contacts"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div style={BODY_STYLE}>
        <EqxListRow primary={activeName ? 'Tap a contact to lock with' : 'No weapon group'}
          side={activeName ? <span style={{ color: groupColourHex(activeIdx) }}>{activeName}</span> : undefined}
          data-testid="contacts-group" />
        <EqxSegmented options={CONTACT_SORTS} value={hostilesFirst ? 'hostile' : 'nearest'}
          onChange={(id) => setHostilesFirst(id === 'hostile')} label="Sort contacts" data-testid="contacts-sort" />
        <EqxSection title="Nearby"data-testid="contacts-list">
          {view.rows.length === 0 && <EqxListRow primary="Nothing to lock nearby" data-testid="contacts-empty" />}
          {view.rows.map((r) => <Row key={r.key} r={r} groups={groups} activeIdx={activeIdx} onTap={onRow} />)}
        </EqxSection>
      </div>
    </EqxPanel>
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
  const reachTitle = r.inActiveReach ? 'in fire range of the active group' : r.inAnyReach ? 'in fire range of another group' : 'out of fire range (still lockable)';
  const lockState = lock === null ? 'none' : lock.stage === 2 ? 'locked' : 'acquiring';
  const side = (
    <span style={SIDE_STYLE}>
      {r.lockingYou > 0 && (
        <span title={r.lockingYou === 2 ? 'has you locked' : 'locking you'} style={THREAT_STYLE}>
          {r.lockingYou === 2 ? '⚠' : '◎'}
        </span>
      )}
      <span title={reachTitle} style={{ color: r.inActiveReach ? reachCol : HUD.color.inkDim }}>{reachMark}</span>
      <span>{formatContactKm(r.dist)}</span>
      <span style={{ ...LOCK_STYLE, color: lockCol }}>{lock === null ? '' : lock.stage === 2 ? 'LOCKED' : `${lock.pct}%`}</span>
    </span>
  );
  return (
    <EqxListRow
      primary={r.name}
      icon={<KindIcon kind={r.icon} />}
      side={side}
      onTap={() => onTap(r)}
      dim={!r.inAnyReach}
      selected={r.activeLock !== null}
      data-testid={`contact-row-${r.key}`}
      dataAttrs={{
        key: r.key,
        kind: r.icon,
        lock: lockState,
        'lock-group': lock?.groupId ?? '',
        'in-reach': r.inActiveReach ? 'active' : r.inAnyReach ? 'any' : 'none',
        'locking-you': r.lockingYou,
      }}
    />
  );
}
