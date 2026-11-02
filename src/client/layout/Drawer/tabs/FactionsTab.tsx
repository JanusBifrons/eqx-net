/**
 * Factions F3 (plan soft-leaping-truffle v4) — the Factions tab. Every
 * faction's view of you and yours of them (−100..100), plus your own
 * faction's policy: below what your turrets fire, above what someone counts
 * as an ally.
 *
 * Rebuilt ONLY from `GET /trade/factions` (#16), polled only while the tab is
 * on screen (drawer-perf rule); a policy change refetches at once. No raw ids:
 * NPC factions and players show by name.
 */
import { memo, useCallback, useEffect, useState, type HTMLAttributes } from 'react';
import { Box, MenuItem, Select, Typography, type SelectChangeEvent } from '@mui/material';
import { useUIStore } from '../../../state/store';
import { loadStoredPlayerId } from '../../../identity/token';
import { fetchFactions } from '../../../net/tradeApi';
import { sendSetFactionPolicy } from '../../../net/tradeClient';
import { formatStanding, repLabel } from '../../../net/tradeView';
import type { PlayerFactionsView, PlayerPolicyWire } from '../../../../shared-types/factions';

const POLL_MS = 4000;
const HOSTILE_STEPS = [-10, -25, -50, -75] as const;
const ALLIED_STEPS = [25, 50, 75] as const;

const TITLE_SX = { fontSize: 13, fontWeight: 700, color: '#dffff0', mb: 0.75 } as const;
const SECTION_SX = { fontSize: 10, color: '#9aa0b4', textTransform: 'uppercase', letterSpacing: 0.6, mt: 1, mb: 0.5 } as const;
const POLICY_ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 } as const;
const POLICY_LABEL_SX = { flex: 1, fontSize: 10, color: '#c8cde0' } as const;
const SELECT_SX = { fontSize: 11, minWidth: 64, '& .MuiSelect-select': { py: 0.25, px: 0.75 } } as const;
const ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, py: 0.4, borderBottom: '1px solid rgba(255,255,255,0.06)' } as const;
const NAME_SX = { flex: 1, fontSize: 11, color: '#dde3ef', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const VIEW_SX = { width: 82, fontSize: 10, textAlign: 'right' } as const;
const DETAIL_SX = { fontSize: 10, color: '#9aa0b4' } as const;
// The clickable part of each select carries a testid for E2E.
const HOSTILE_BUTTON_PROPS = { 'data-testid': 'faction-policy-hostile-button' } as HTMLAttributes<HTMLDivElement>;
const ALLIED_BUTTON_PROPS = { 'data-testid': 'faction-policy-allied-button' } as HTMLAttributes<HTMLDivElement>;

function standingColor(v: number): string {
  return v >= 15 ? '#5fd6a0' : v > -15 ? '#c8cde0' : '#ff8a8a';
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

export const FactionsTab = memo(function FactionsTab(): JSX.Element {
  const visible = useUIStore((s) => s.drawerTab === 'factions' && s.isDrawerOpen);
  const [view, setView] = useState<PlayerFactionsView | null>(null);
  const playerId = loadStoredPlayerId();

  const load = useCallback(async (): Promise<void> => {
    if (!playerId) return;
    const v = await fetchFactions(playerId);
    if (v !== null) setView(v);
  }, [playerId]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, load]);

  const policy = view?.policy ?? { hostileBelow: null, alliedAbove: null };
  const setPolicy = (next: PlayerPolicyWire): void => {
    if (!sendSetFactionPolicy(next)) return;
    setView((v) => (v ? { ...v, policy: next } : v));
    setTimeout(() => void load(), 300);
  };
  const onHostile = (e: SelectChangeEvent<string>): void => {
    setPolicy({ ...policy, hostileBelow: e.target.value === 'off' ? null : Number(e.target.value) });
  };
  const onAllied = (e: SelectChangeEvent<string>): void => {
    setPolicy({ ...policy, alliedAbove: e.target.value === 'off' ? null : Number(e.target.value) });
  };

  return (
    <Box sx={{ p: 1 }} data-testid="factions-tab">
      <Typography sx={TITLE_SX}>Factions</Typography>

      <Typography sx={SECTION_SX}>Your policy</Typography>
      <Box sx={POLICY_ROW_SX}>
        <Typography sx={POLICY_LABEL_SX}>Your turrets fire on anyone you rate below</Typography>
        <Select
          size="small"
          sx={SELECT_SX}
          value={policy.hostileBelow === null ? 'off' : String(policy.hostileBelow)}
          onChange={onHostile}
          inputProps={{ 'data-testid': 'faction-policy-hostile' }}
          SelectDisplayProps={HOSTILE_BUTTON_PROPS}
        >
          <MenuItem value="off" sx={{ fontSize: 11 }}>Off</MenuItem>
          {HOSTILE_STEPS.map((v) => <MenuItem key={v} value={String(v)} sx={{ fontSize: 11 }}>{v}</MenuItem>)}
        </Select>
      </Box>
      <Box sx={POLICY_ROW_SX}>
        <Typography sx={POLICY_LABEL_SX}>Anyone you rate above this is an ally</Typography>
        <Select
          size="small"
          sx={SELECT_SX}
          value={policy.alliedAbove === null ? 'off' : String(policy.alliedAbove)}
          onChange={onAllied}
          inputProps={{ 'data-testid': 'faction-policy-allied' }}
          SelectDisplayProps={ALLIED_BUTTON_PROPS}
        >
          <MenuItem value="off" sx={{ fontSize: 11 }}>Off</MenuItem>
          {ALLIED_STEPS.map((v) => <MenuItem key={v} value={String(v)} sx={{ fontSize: 11 }}>+{v}</MenuItem>)}
        </Select>
      </Box>

      <Typography sx={SECTION_SX}>Standing</Typography>
      <Box sx={{ display: 'flex', gap: 0.75, mb: 0.25 }}>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ ...VIEW_SX, color: '#9aa0b4' }}>Their view</Typography>
        <Typography sx={{ ...VIEW_SX, width: 44, color: '#9aa0b4' }}>Yours</Typography>
      </Box>
      {!playerId && <Typography sx={DETAIL_SX}>Sign in to build standing with factions.</Typography>}
      {playerId && view === null && <Typography sx={DETAIL_SX}>Loading…</Typography>}
      {view?.rows.map((r) => (
        <Box
          key={r.factionId}
          sx={ROW_SX}
          data-testid="faction-row"
          data-faction-kind={r.kind}
          data-their-view={r.theirView}
          data-your-view={r.yourView}
        >
          <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: hex(r.color), flexShrink: 0 }} />
          <Typography sx={NAME_SX} title={r.name}>{r.name}</Typography>
          <Typography sx={{ ...VIEW_SX, color: standingColor(r.theirView) }}>
            {repLabel(r.theirView)} {formatStanding(r.theirView)}
          </Typography>
          <Typography sx={{ ...VIEW_SX, width: 44, color: standingColor(r.yourView) }}>{formatStanding(r.yourView)}</Typography>
        </Box>
      ))}
    </Box>
  );
});
