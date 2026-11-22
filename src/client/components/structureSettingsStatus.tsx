/**
 * The Settings section's status block (Details panel), above the pages: owner, level,
 * connections (a connector) and the hold summary (owned storage). These left
 * the inspector card (building-panels A2). Read from the structure slice and
 * the selection's server stats (the hold is owner-only on the wire) at the
 * panel's 4 Hz cadence.
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { getGameClient } from '../net/clientSingleton';
import { selectionStats } from '../net/selectionStats';
import { getStructureKind } from '@shared-types/structureKinds';
import { HUD } from '../hud/tokens';
import { WINDOW_EDGE } from './GameWindow';
import { structureOwnerLabel } from './ownerLabel';

// The owner label rule lives in the pure `ownerLabel.ts`; re-exported for callers.
export { structureOwnerLabel };

export interface SettingsStatusView {
  owner: string | undefined;
  level: number;
  /** Connector only: connections used / max. */
  conn: string | undefined;
  /** Owned storage: "40/500 · 40 Salvage". */
  hold: string | undefined;
}

export function readSettingsStatus(entityId: number): SettingsStatusView | null {
  const client = getGameClient();
  const st = client?.mirror.structures?.get(entityId);
  if (!st) return null;
  const kindId = client?.mirror.swarm?.get(entityId)?.shipKind;
  const hold = selectionStats.id === String(entityId) && selectionStats.holdLine !== undefined
    ? `${selectionStats.holdUse ?? ''} · ${selectionStats.holdLine}` : undefined;
  return {
    owner: st.owner ? structureOwnerLabel(st.owner, st.ownerName, client?.mirror.localPlayerId ?? null) : undefined,
    level: st.level ?? 1,
    conn: kindId === 'connector' ? `${st.connTo.length} / ${getStructureKind('connector').maxConnections ?? 0}` : undefined,
    hold,
  };
}

function sameStatus(a: SettingsStatusView | null, b: SettingsStatusView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.level === b.level && a.conn === b.conn && a.hold === b.hold;
}

export function SettingsStatus({ entityId, pollMs }: { entityId: number; pollMs: number }): JSX.Element | null {
  const [s, setS] = useState<SettingsStatusView | null>(() => readSettingsStatus(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setS((prev) => {
      const next = readSettingsStatus(entityId);
      return sameStatus(prev, next) ? prev : next;
    }), pollMs);
    return () => window.clearInterval(h);
  }, [entityId, pollMs]);
  if (s === null) return null;
  return (
    <Box sx={ROOT_SX} data-testid="settings-status">
      {s.owner !== undefined && <Item label="Owner" value={s.owner} testId="settings-status-owner" />}
      <Item label="Level" value={String(s.level)} testId="settings-status-level" />
      {s.conn !== undefined && <Item label="Conn" value={s.conn} testId="settings-status-conn" />}
      {s.hold !== undefined && <Item label="Hold" value={s.hold} testId="settings-status-hold" wide />}
    </Box>
  );
}

function Item({ label, value, testId, wide = false }: { label: string; value: string; testId: string; wide?: boolean }): JSX.Element {
  return (
    <Box sx={wide ? WIDE_SX : ITEM_SX} data-testid={testId}>
      <Box component="span" sx={LABEL_SX}>{label}</Box> <Box component="span" sx={VALUE_SX}>{value}</Box>
    </Box>
  );
}

const C = HUD.color;
const ROOT_SX = {
  flex: 'none', display: 'flex', flexWrap: 'wrap' as const, columnGap: 2, rowGap: 0.5,
  px: 1.5, py: 0.75, borderBottom: WINDOW_EDGE, fontSize: 12,
} as const;
const ITEM_SX = { whiteSpace: 'nowrap' as const } as const;
const WIDE_SX = { flexBasis: '100%' } as const;
const LABEL_SX = { color: C.inkDim, fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' as const } as const;
const VALUE_SX = { color: C.ink, fontFamily: HUD.font.num } as const;
