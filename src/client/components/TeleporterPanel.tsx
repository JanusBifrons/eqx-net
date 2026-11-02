/**
 * v4 T1 — the teleporter section of the inspector, for the pilot's OWN built
 * teleporter. Reads the teleporter's room-state row from the render mirror
 * (structures come from room state, #16) at a few Hz while mounted.
 *
 *  - charge (% of the jump's charge) and the jump cycle phase;
 *  - Pair with another of your teleporters here (listed by kind and distance,
 *    never ids), Unpair, Fire;
 *  - firing rules: when charged / when a ship boards;
 *  - the pad hold: load a good from base storage, or unload it all.
 */
import { memo, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { getGameClient } from '../net/clientSingleton';
import {
  sendSetTeleportRules,
  sendTeleportFire,
  sendTeleportPadLoad,
  sendTeleportPadUnload,
  sendTeleportPair,
  sendTeleportUnpair,
} from '../structures/structureActionsClient';
import { getStructureKind, isStructureKindId } from '../../shared-types/structureKinds';
import {
  DEFAULT_TELEPORT_RULES,
  PAD_SPECS,
  TP_PARTNER_REMOTE,
  TP_PHASE,
  TP_RULE_BOARDS,
  TP_RULE_CHARGED,
  isTeleporterKind,
  type TeleportRules,
} from '../../shared-types/teleport';
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods';

const POLL_MS = 250;
const ROOT_SX = { mt: 0.5, pointerEvents: 'auto' as const, fontSize: 10, color: '#dcd4ff', maxWidth: 240 };
const TITLE_SX = { fontSize: 10, fontWeight: 700, color: '#b9a6ff', mb: '2px' };
const BAR_SX = { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', my: '2px' };
const ROW_SX = { display: 'flex', flexWrap: 'wrap' as const, gap: '3px', mt: '3px', alignItems: 'center' };
const BTN_SX = {
  px: 0.75, py: '2px', borderRadius: '3px', cursor: 'pointer', userSelect: 'none' as const,
  border: '1px solid rgba(185,166,255,0.8)', color: '#efeaff', backgroundColor: 'rgba(60,40,120,0.6)', fontSize: 10,
};
const BTN_OFF_SX = { ...BTN_SX, opacity: 0.4, cursor: 'default' };
const CHIP_ON_SX = { ...BTN_SX, backgroundColor: 'rgba(120,90,230,0.85)' };
const SELECT_STYLE = { fontSize: 10, background: '#1b1530', color: '#efeaff', border: '1px solid #6b5aa8', borderRadius: 3 } as const;

const PHASE_LABEL: Readonly<Record<number, string>> = {
  [TP_PHASE.IDLE]: 'Ready',
  [TP_PHASE.ARMED]: 'Departing soon',
  [TP_PHASE.CLOSING]: 'Doors closing',
  [TP_PHASE.SEALED]: 'Sealed, charging',
  [TP_PHASE.OPEN]: 'Arrived, doors opening',
};

interface View {
  kind: string;
  phase: number;
  chargePct: number;
  partner: number;
  rules: number;
  padWeight: number;
  x: number;
  y: number;
  /** Your other teleporters here that could be its partner. */
  candidates: Array<{ entityId: number; label: string }>;
}

function readView(entityId: number): View | null {
  const m = getGameClient()?.mirror;
  const st = m?.structures?.get(entityId);
  const sw = m?.swarm?.get(entityId);
  const kind = sw?.shipKind;
  if (!st?.teleport || !sw || kind === undefined || !isTeleporterKind(kind)) return null;
  const candidates: View['candidates'] = [];
  for (const [id, other] of m!.structures!) {
    if (id === entityId || other.owner !== m!.localPlayerId || other.built !== true) continue;
    const o = m!.swarm?.get(id);
    if (!o?.shipKind || !isTeleporterKind(o.shipKind)) continue;
    const km = Math.hypot(o.x - sw.x, o.y - sw.y) / 1000;
    const name = isStructureKindId(o.shipKind) ? getStructureKind(o.shipKind).displayName : 'Teleporter';
    candidates.push({ entityId: id, label: `${name} · ${km.toFixed(1)} km` });
  }
  const t = st.teleport;
  return { kind, phase: t.phase, chargePct: t.chargePct, partner: t.partner, rules: t.rules, padWeight: t.padWeight, x: sw.x, y: sw.y, candidates };
}

function sameView(a: View | null, b: View | null): boolean {
  if (a === null || b === null) return a === b;
  return a.phase === b.phase && a.chargePct === b.chargePct && a.partner === b.partner && a.rules === b.rules
    && a.padWeight === b.padWeight && a.candidates.length === b.candidates.length;
}

export const TeleporterPanel = memo(function TeleporterPanel({ entityId }: { entityId: number }): JSX.Element | null {
  const [view, setView] = useState<View | null>(() => readView(entityId));
  const [good, setGood] = useState<GoodId>('alloy');

  useEffect(() => {
    const t = setInterval(() => {
      const next = readView(entityId);
      setView((prev) => (sameView(prev, next) ? prev : next));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [entityId]);

  if (view === null) return null;
  const paired = view.partner !== -1;
  const idle = view.phase === TP_PHASE.IDLE;
  const canFire = paired && idle && view.chargePct >= 100;
  const cap = PAD_SPECS[view.kind as keyof typeof PAD_SPECS].padCapacity;
  const rules: TeleportRules = {
    ...DEFAULT_TELEPORT_RULES,
    whenCharged: (view.rules & TP_RULE_CHARGED) !== 0,
    shipBoards: (view.rules & TP_RULE_BOARDS) !== 0,
  };
  const toggle = (key: 'whenCharged' | 'shipBoards'): void => {
    sendSetTeleportRules(entityId, { ...rules, [key]: !rules[key] });
  };

  return (
    <Box sx={ROOT_SX} data-testid="tp-panel" data-phase={view.phase} data-charge-pct={view.chargePct} data-paired={paired ? 1 : 0}>
      <Box sx={TITLE_SX}>TELEPORTER · {PHASE_LABEL[view.phase] ?? ''}</Box>
      <Box data-testid="tp-charge">{`CHARGE ${view.chargePct}%`}</Box>
      <Box sx={BAR_SX}>
        <Box sx={{ height: '100%', width: `${view.chargePct}%`, backgroundColor: '#9b7bff' }} />
      </Box>
      <Box data-testid="tp-partner">
        {!paired ? 'Not paired' : view.partner === TP_PARTNER_REMOTE ? 'Paired with a pad in another sector' : 'Paired'}
      </Box>
      <Box sx={ROW_SX}>
        {paired ? (
          <>
            <Box component="span" sx={canFire ? BTN_SX : BTN_OFF_SX} data-testid="tp-fire" onClick={() => canFire && sendTeleportFire(entityId)}>
              Fire
            </Box>
            <Box component="span" sx={BTN_SX} data-testid="tp-unpair" onClick={() => sendTeleportUnpair(entityId)}>
              Unpair
            </Box>
          </>
        ) : view.candidates.length === 0 ? (
          <span>Build a second teleporter here to pair.</span>
        ) : (
          view.candidates.map((c) => (
            <Box key={c.entityId} component="span" sx={BTN_SX} data-testid="tp-pair-option" onClick={() => sendTeleportPair(entityId, c.entityId)}>
              {`Pair: ${c.label}`}
            </Box>
          ))
        )}
      </Box>
      <Box sx={ROW_SX}>
        <span>Fire:</span>
        <Box component="span" sx={rules.whenCharged ? CHIP_ON_SX : BTN_SX} data-testid="tp-rule-charged" onClick={() => toggle('whenCharged')}>
          when charged
        </Box>
        <Box component="span" sx={rules.shipBoards ? CHIP_ON_SX : BTN_SX} data-testid="tp-rule-boards" onClick={() => toggle('shipBoards')}>
          when a ship boards
        </Box>
      </Box>
      <Box sx={ROW_SX} data-testid="tp-pad" data-pad-weight={view.padWeight}>
        <span>{`PAD ${view.padWeight} / ${cap}`}</span>
        <select style={SELECT_STYLE} value={good} onChange={(e) => setGood(e.target.value as GoodId)} data-testid="tp-load-good">
          {GOOD_IDS.map((g) => <option key={g} value={g}>{GOOD_DEFS[g].displayName}</option>)}
        </select>
        <Box component="span" sx={BTN_SX} data-testid="tp-load" onClick={() => sendTeleportPadLoad(entityId, good, 10)}>
          Load 10
        </Box>
        <Box component="span" sx={BTN_SX} data-testid="tp-unload" onClick={() => sendTeleportPadUnload(entityId)}>
          Unload
        </Box>
      </Box>
    </Box>
  );
});
