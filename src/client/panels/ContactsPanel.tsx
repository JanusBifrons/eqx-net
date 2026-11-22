/**
 * The Contacts right panel (UI language plan A4, job U2-3): an EVE-style table
 * of what you can lock, for picking far targets without zooming out (owner,
 * 2026-11-10: "lock and pick targets like you do in Eve where you're reduced
 * to a list view like you use when you warp to"). Columns (owner, 2026-11-22):
 * Name (kind icon), Lock (locking-you, lock state), Type, Faction, Stance,
 * Distance. The lock marks get their own narrow column so the name never
 * loses width to them on a phone.
 * Every header taps to sort (the tapped column becomes the primary key, the
 * previous one the tie-break: `tapContactSort`); default nearest first. Row
 * text is the stance colour. Paged (`CONTACTS_PAGE_SIZE`); the filter button
 * shows Type / Stance / Faction filters.
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
 * (`contactsSignature`). Sort, filters and page are local component state
 * (they survive the refresh); only the `rightPanel` flag lives in Zustand (#2).
 */
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  EQX_PANEL_SIZE, EqxDropdown, EqxIcon, EqxIconButton, EqxListRow, EqxPanel, EqxSegmented, EqxTable,
  type EqxTableColumn,
} from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { ENTITY_VISUALS, entityBadgePolygon, type EntityKind } from '../render/entityVisuals';
import { FAILSAFE_COLOUR, THREAT_COLOUR_HEX, groupColourHex } from '../hud/groupColours';
import { HUD } from '../hud/tokens';
import {
  CONTACTS_PAGE_SIZE, CONTACT_STANCE_LABEL, CONTACT_TYPE_LABEL, DEFAULT_CONTACT_SORT, NO_CONTACT_FILTER,
  buildContactRows, contactFactions, contactTapAction, contactsSignature, filterContacts, formatContactKm,
  sortContacts, tapContactSort,
  type ContactFilter, type ContactRow, type ContactSort, type ContactSortKey, type ContactStance,
  type ContactType, type GroupReach,
} from '../components/contactRows';

const POLL_MS = 250;
const FAILSAFE_HEX = `#${FAILSAFE_COLOUR.toString(16)}`;
const ALL = 'all';
const FACTION_PREFIX = 'f:';

/** Row text colour per stance: the shared relationship colours (radar, icons). */
export const STANCE_COLOUR: Readonly<Record<ContactStance, string>> = {
  hostile: ENTITY_VISUALS.hostile.cssColor,
  neutral: ENTITY_VISUALS.neutral.cssColor,
  friendly: ENTITY_VISUALS.ship.cssColor,
};

const TYPE_OPTIONS = [
  { id: ALL, label: 'All' },
  { id: 'ship', label: CONTACT_TYPE_LABEL.ship },
  { id: 'structure', label: CONTACT_TYPE_LABEL.structure },
] as const;
const STANCE_OPTIONS = [
  { id: ALL, label: 'All' },
  { id: 'hostile', label: CONTACT_STANCE_LABEL.hostile },
  { id: 'neutral', label: CONTACT_STANCE_LABEL.neutral },
  { id: 'friendly', label: CONTACT_STANCE_LABEL.friendly },
] as const;

const BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: HUD.panel.bodyGap, minWidth: 0 };
const HEAD_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: HUD.panel.rowGap, minWidth: 0 };
const GROW_STYLE: CSSProperties = { flex: 1, minWidth: 0 };
const NAME_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 };
const NAME_TEXT_STYLE: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const LOCK_CELL_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 };
const LOCK_STYLE: CSSProperties = { flex: 'none', fontWeight: 700, fontSize: HUD.table.smallFont };
const THREAT_STYLE: CSSProperties = { flex: 'none', color: THREAT_COLOUR_HEX, fontWeight: 700 };
const ICON_STYLE: CSSProperties = { display: 'block', flex: 'none' };
const REACH_STYLE: CSSProperties = { marginRight: 3 };

/** Column widths, px (a ~305 px table body on a phone held sideways: 36vw of
 *  915, minus padding). Name takes 2.5 shares of what is left, Faction 1. */
const COL_W = { lock: 44, type: 46, stance: 46, dist: 50 } as const;
const NAME_GROW = 2.5;

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

/** All contacts (unsorted, unfiltered) and their signature. */
function poll(activeGroupId: string | null, groupIds: ReadonlyArray<string>): View {
  const c = getGameClient();
  if (!c) return { rows: [], sig: '' };
  const reaches: GroupReach[] = groupIds.map((id) => ({ id, reach: c.fcGroupReach(id) }));
  const rows = buildContactRows(c.mirror, activeGroupId, reaches);
  return { rows, sig: contactsSignature(rows) };
}

export const ContactsPanel = memo(function ContactsPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'contacts');
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const groups = useUIStore((s) => s.fcGroups);
  const activeGroupId = useUIStore((s) => s.activeGroupId);
  const [view, setView] = useState<View>({ rows: [], sig: '' });
  const [sort, setSort] = useState<ContactSort>(DEFAULT_CONTACT_SORT);
  const [filter, setFilter] = useState<ContactFilter>(NO_CONTACT_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);

  useEffect(() => {
    if (!open) return undefined;
    const ids = groups.map((g) => g.id);
    const tick = (): void => {
      const next = poll(activeGroupId, ids);
      setView((prev) => (prev.sig === next.sig ? prev : next));
    };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(h);
  }, [open, groups, activeGroupId]);

  const shown = useMemo(() => sortContacts(filterContacts(view.rows, filter), sort), [view, filter, sort]);
  const factions = useMemo(() => contactFactions(view.rows), [view]);

  const activeIdx = groups.findIndex((g) => g.id === activeGroupId);
  const activeName = activeIdx >= 0 ? groups[activeIdx]!.name : '';

  const onRow = (r: ContactRow): void => {
    const c = getGameClient();
    if (!c || !activeGroupId) return;
    if (contactTapAction(r) === 'cancel') c.cancelLock(activeGroupId, r.key);
    else c.requestLock(activeGroupId, r.key);
  };
  const onSort = (id: string): void => { setSort((s) => tapContactSort(s, id as ContactSortKey)); setPage(0); };
  const patchFilter = (p: Partial<ContactFilter>): void => { setFilter((f) => ({ ...f, ...p })); setPage(0); };
  const filtersOn = filter.type !== null || filter.faction !== null || filter.stance !== null;
  const columns = contactColumns(groups, activeIdx);
  const primary = sort[0] ?? null;

  return (
    <EqxPanel
      open={open}
      onClose={onClose}
      // The test id goes on the Paper: the persistent Drawer root is zero-size.
      testId="contacts-panel-root"
      paperAttrs={{ 'data-testid': 'contacts-panel', 'data-count': String(shown.length) }}
      closeTestId="contacts-panel-close"
      title="Contacts"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div style={BODY_STYLE}>
        <div style={HEAD_STYLE}>
          <div style={GROW_STYLE}>
            <EqxListRow primary={activeName ? 'Tap a contact to lock with' : 'No weapon group'}
              side={activeName ? <span style={{ color: groupColourHex(activeIdx) }}>{activeName}</span> : undefined}
              data-testid="contacts-group" />
          </div>
          <EqxIconButton icon={<EqxIcon name="filter" />} tooltip={showFilters ? 'Hide filters' : 'Filters'}
            active={showFilters || filtersOn} onClick={() => setShowFilters((v) => !v)}
            data-testid="contacts-filters-toggle" data-state={showFilters ? 'open' : 'closed'} />
        </div>
        {showFilters && (
          <div style={BODY_STYLE} data-testid="contacts-filters">
            <EqxSegmented options={TYPE_OPTIONS} value={filter.type ?? ALL} label="Type"
              onChange={(id) => patchFilter({ type: id === ALL ? null : (id as ContactType) })}
              data-testid="contacts-filter-type" />
            <EqxSegmented options={STANCE_OPTIONS} value={filter.stance ?? ALL} label="Stance"
              onChange={(id) => patchFilter({ stance: id === ALL ? null : (id as ContactStance) })}
              data-testid="contacts-filter-stance" />
            <EqxDropdown label="Faction"
              options={[{ id: ALL, label: 'All factions' }, ...factionOptions(factions, filter.faction)]}
              value={filter.faction === null ? ALL : FACTION_PREFIX + filter.faction}
              onChange={(id) => patchFilter({ faction: id === null || id === ALL ? null : id.slice(FACTION_PREFIX.length) })}
              data-testid="contacts-filter-faction" />
          </div>
        )}
        <EqxTable
          columns={columns}
          rows={shown}
          rowKey={(r) => r.key}
          label="Contacts"
          sort={primary === null ? null : { id: primary.key, dir: primary.dir }}
          onSort={onSort}
          onRowTap={onRow}
          rowLabel={(r) => `${r.name}, ${r.faction}`}
          rowColor={(r) => STANCE_COLOUR[r.stance]}
          rowDim={(r) => !r.inAnyReach}
          rowSelected={(r) => r.activeLock !== null}
          rowTestId={(r) => `contact-row-${r.key}`}
          rowDataAttrs={rowAttrs}
          pageSize={CONTACTS_PAGE_SIZE}
          page={page}
          onPageChange={setPage}
          empty={<span data-testid="contacts-empty">{view.rows.length === 0 ? 'Nothing to lock nearby' : 'No contacts match the filters'}</span>}
          data-testid="contacts-list"
        />
      </div>
    </EqxPanel>
  );
});

/** Faction filter options; a chosen faction that left stays listed. */
function factionOptions(factions: ReadonlyArray<string>, chosen: string | null): { id: string; label: string }[] {
  const names = chosen !== null && !factions.includes(chosen) ? [...factions, chosen] : factions;
  return names.map((f) => ({ id: FACTION_PREFIX + f, label: f }));
}

function rowAttrs(r: ContactRow): Record<string, string | number> {
  const lock = r.lock;
  return {
    key: r.key,
    kind: r.icon,
    type: r.type,
    faction: r.faction,
    stance: r.stance,
    lock: lock === null ? 'none' : lock.stage === 2 ? 'locked' : 'acquiring',
    'lock-group': lock?.groupId ?? '',
    'in-reach': r.inActiveReach ? 'active' : r.inAnyReach ? 'any' : 'none',
    'locking-you': r.lockingYou,
  };
}

function contactColumns(groups: ReadonlyArray<{ id: string }>, activeIdx: number): EqxTableColumn<ContactRow>[] {
  const reachCol = activeIdx >= 0 ? groupColourHex(activeIdx) : HUD.color.inkDim;
  return [
    { id: 'name', label: 'Name', grow: NAME_GROW, cell: (r) => <NameCell r={r} /> },
    { id: 'lock', label: 'Lock', width: COL_W.lock, cell: (r) => <LockCell r={r} groups={groups} /> },
    { id: 'type', label: 'Type', width: COL_W.type, cell: (r) => CONTACT_TYPE_LABEL[r.type] },
    { id: 'faction', label: 'Faction', grow: 1, cell: (r) => r.faction },
    { id: 'stance', label: 'Stance', width: COL_W.stance, cell: (r) => CONTACT_STANCE_LABEL[r.stance] },
    {
      id: 'dist', label: 'Dist', width: COL_W.dist, alignRight: true, numeric: true,
      cell: (r) => {
        const mark = r.inActiveReach ? '●' : r.inAnyReach ? '○' : '·';
        const title = r.inActiveReach ? 'in fire range of the active group' : r.inAnyReach ? 'in fire range of another group' : 'out of fire range (still lockable)';
        return (
          <>
            <span title={title} style={{ ...REACH_STYLE, color: r.inActiveReach ? reachCol : HUD.color.inkDim }}>{mark}</span>
            {formatContactKm(r.dist)}
          </>
        );
      },
    },
  ];
}

function NameCell({ r }: { r: ContactRow }): JSX.Element {
  return (
    <span style={NAME_STYLE}>
      <KindIcon kind={r.icon} />
      <span style={NAME_TEXT_STYLE}>{r.name}</span>
    </span>
  );
}

/** Locking you (⚠ locked / ◎ locking, threat colour), then your lock (LOCK or
 *  the acquiring percent, in the holding group's colour); empty otherwise. */
function LockCell({ r, groups }: { r: ContactRow; groups: ReadonlyArray<{ id: string }> }): JSX.Element {
  const lock = r.lock;
  const lockIdx = lock ? groups.findIndex((g) => g.id === lock.groupId) : -1;
  const lockCol = lock ? (lock.stage === 0 ? FAILSAFE_HEX : groupColourHex(lockIdx)) : undefined;
  return (
    <span style={LOCK_CELL_STYLE}>
      {r.lockingYou > 0 && (
        <span title={r.lockingYou === 2 ? 'has you locked' : 'locking you'} style={THREAT_STYLE}>
          {r.lockingYou === 2 ? '⚠' : '◎'}
        </span>
      )}
      {lock !== null && <span style={{ ...LOCK_STYLE, color: lockCol }}>{lock.stage === 2 ? 'LOCK' : `${lock.pct}%`}</span>}
    </span>
  );
}
