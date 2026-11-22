/**
 * Factions F3 (plan soft-leaping-truffle v4) — the Factions page, the main
 * page of the Faction panel (`panels/FactionPanel.tsx`). Every
 * faction's view of you and yours of them (−100..100), plus your own
 * faction's policy: below what your turrets fire, above what someone counts
 * as an ally.
 *
 * Rebuilt ONLY from `GET /trade/factions` (#16), polled only while the tab is
 * on screen (drawer-perf rule); a policy change refetches at once. No raw ids:
 * NPC factions and players show by name.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { EqxDropdown } from '../../../../ui/index.js';
import { HUD } from '../../../hud/tokens';
import { useUIStore } from '../../../state/store';
import { selectDrawerTabShown } from '../../../state/rightPanel';
import { loadStoredPlayerId } from '../../../identity/token';
import { fetchFactions } from '../../../net/tradeApi';
import { sendSetFactionPolicy } from '../../../net/tradeClient';
import { formatStanding, repLabel } from '../../../net/tradeView';
import type { PlayerFactionsView, PlayerPolicyWire } from '../../../../shared-types/factions';
import { DETAIL_SX, SECTION_SX, hex } from './factionsTabStyles';

const POLL_MS = 4000;
const HOSTILE_STEPS = [-10, -25, -50, -75] as const;
const ALLIED_STEPS = [25, 50, 75] as const;

const OFF = 'off';
const HOSTILE_OPTIONS = [{ id: OFF, label: 'Off' }, ...HOSTILE_STEPS.map((v) => ({ id: String(v), label: String(v) }))];
const ALLIED_OPTIONS = [{ id: OFF, label: 'Off' }, ...ALLIED_STEPS.map((v) => ({ id: String(v), label: `+${v}` }))];

/** The policy fields stacked under the heading, panel body gap apart. */
const POLICY_SX = { display: 'flex', flexDirection: 'column', gap: `${HUD.panel.bodyGap}px` } as const;
const ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, py: 0.4, borderBottom: '1px solid rgba(255,255,255,0.06)' } as const;
const NAME_SX = { flex: 1, fontSize: 11, color: '#dde3ef', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const VIEW_SX = { width: 82, fontSize: 10, textAlign: 'right' } as const;

function standingColor(v: number): string {
  return v >= 15 ? '#5fd6a0' : v > -15 ? '#c8cde0' : '#ff8a8a';
}

export const FactionsTab = memo(function FactionsTab(): JSX.Element {
  const visible = useUIStore(selectDrawerTabShown('factions'));
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
  const onHostile = (id: string | null): void => {
    setPolicy({ ...policy, hostileBelow: id === null || id === OFF ? null : Number(id) });
  };
  const onAllied = (id: string | null): void => {
    setPolicy({ ...policy, alliedAbove: id === null || id === OFF ? null : Number(id) });
  };

  return (
    <Box data-testid="factions-tab">

      <Typography sx={SECTION_SX}>Your policy</Typography>
      <Box sx={POLICY_SX}>
        <EqxDropdown
          label="Your turrets fire on anyone you rate below"
          options={HOSTILE_OPTIONS}
          value={policy.hostileBelow === null ? OFF : String(policy.hostileBelow)}
          onChange={onHostile}
          data-testid="faction-policy-hostile"
        />
        <EqxDropdown
          label="Anyone you rate above this is an ally"
          options={ALLIED_OPTIONS}
          value={policy.alliedAbove === null ? OFF : String(policy.alliedAbove)}
          onChange={onAllied}
          data-testid="faction-policy-allied"
        />
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
