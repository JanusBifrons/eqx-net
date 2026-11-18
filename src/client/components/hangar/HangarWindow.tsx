/**
 * Join flow stage 5 — the Hangar: where a pilot picks what to launch into a
 * sector. Replaces the old ship picker and the roster. Class tabs, one tile
 * per hull (a capital's fits fold in behind a toggle), owned hulls parked
 * here in gold (Launch resumes them; Abandon breaks them up), credits and
 * free-launch pips up top, and a footer that says what this launch costs.
 * Every answer comes from `hangarModel` → the shared `launchVerdict`, the same
 * call the server's gate makes.
 */
import { Box, Button, ButtonBase, Dialog, Tab, Tabs, Typography } from '@mui/material';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SHIP_KIND, getShipKind, type ShipKindId } from '../../../shared-types/shipKinds';
import { FREE_LAUNCHES_START } from '../../../shared-types/launch';
import { ShipSilhouette } from '../../render/shipShapeSvg';
import { useUIStore } from '../../state/store';
import { fetchEconomy } from '../../net/tradeApi';
import { FIT_LABEL, HANGAR_TABS, hangarTiles, launchFooter, tabReadyCount, tileVerdict, type HangarPurse, type HangarTile } from './hangarModel';
import { useAbandonShip } from './useAbandonShip';

const GOLD = '#d4a64a';
const BG = '#0c1020';
const EDGE = '#2a2f40';

export interface HangarWindowProps {
  /** The sector being launched into; null = closed. */
  sectorKey: string | null;
  sectorName: string;
  playerId: string;
  /** Last-picked kind, pre-selected when the window opens. */
  selectedKind: ShipKindId;
  onClose: () => void;
  onLaunchNew: (kind: ShipKindId, sectorKey: string) => void;
  onResume: (shipId: string, sectorKey: string) => void;
}

export function HangarWindow({ sectorKey, sectorName, playerId, selectedKind, onClose, onLaunchNew, onResume }: HangarWindowProps): JSX.Element {
  const open = sectorKey !== null;
  const roster = useUIStore((s) => s.shipRoster);
  const storeWallet = useUIStore((s) => s.wallet);
  const storeFree = useUIStore((s) => s.freeLaunches);
  const [econ, setEcon] = useState<{ wallet: number; freeLaunches: number } | null>(null);
  const abandon = useAbandonShip(playerId);

  // The map has no snapshot wallet: read the economy once per open, falling
  // back to the last snapshot's numbers.
  useEffect(() => {
    if (!open || playerId === '') return;
    let live = true;
    void fetchEconomy(playerId).then((v) => {
      if (live && v) setEcon({ wallet: v.wallet ?? 0, freeLaunches: v.freeLaunches ?? FREE_LAUNCHES_START });
    });
    return () => { live = false; };
  }, [open, playerId]);

  /** kind → a parked hull of that kind in this sector (first one). */
  const ownedShips = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of roster) if (s.sectorKey === sectorKey && !m.has(s.kind)) m.set(s.kind, s.shipId);
    return m;
  }, [roster, sectorKey]);

  const purse: HangarPurse = {
    wallet: econ?.wallet ?? storeWallet ?? 0,
    freeLaunches: econ?.freeLaunches ?? storeFree ?? FREE_LAUNCHES_START,
    ownedHere: new Set(ownedShips.keys()),
  };

  // The remembered kind, unless it can't launch here (then the Fighter).
  const onTab = (k: string): number => HANGAR_TABS.findIndex((t) => hangarTiles(t).some((x) => x.fits.some((f) => f.kind === k)));
  const startKind: string = onTab(selectedKind) >= 0 && tileVerdict(selectedKind, purse).kind !== 'refuse' ? selectedKind : DEFAULT_SHIP_KIND;
  const startTab = Math.max(0, onTab(startKind));
  const [tabIx, setTabIx] = useState(startTab);
  const [kind, setKind] = useState<string>(startKind);
  // Re-seed only when the window opens (not as the wallet read lands).
  useEffect(() => { if (open) { setTabIx(startTab); setKind(startKind); } }, [open]);

  const tab = HANGAR_TABS[tabIx]!;
  const tiles = hangarTiles(tab);
  const verdict = tileVerdict(kind, purse);
  const footer = launchFooter(verdict, purse.wallet);
  const ownedShipId = ownedShips.get(kind);

  const launch = (): void => {
    if (sectorKey === null || verdict.kind === 'refuse') return;
    if (ownedShipId !== undefined) onResume(ownedShipId, sectorKey);
    else onLaunchNew(kind as ShipKindId, sectorKey);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      data-testid="hangar-window"
      PaperProps={{ sx: { bgcolor: BG, border: `1px solid ${EDGE}`, m: 1, maxHeight: 'calc(100% - 16px)' } }}
      // No open transition: the PICKER_OPEN_DELAY_MS touch-bleed guard already delays it.
      transitionDuration={{ enter: 0, exit: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 1 }}>
        <Typography sx={{ color: '#00ff88', fontSize: 13, fontWeight: 600, flex: 1 }}>Hangar · {sectorName}</Typography>
        <Typography data-testid="hangar-wallet" sx={{ color: purse.wallet < 0 ? '#ff7a7a' : '#cde', fontSize: 11 }}>
          {purse.wallet.toLocaleString('en-GB')} cr
        </Typography>
        <Box data-testid="hangar-free-launches" data-count={purse.freeLaunches} title="Free capital launches" sx={{ display: 'flex', gap: '3px' }}>
          {Array.from({ length: FREE_LAUNCHES_START }, (_, i) => (
            <Box key={i} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: i < purse.freeLaunches ? GOLD : 'transparent', border: `1px solid ${GOLD}` }} />
          ))}
        </Box>
      </Box>
      <Tabs value={tabIx} onChange={(_, v: number) => setTabIx(v)} variant="fullWidth" sx={{ minHeight: 30, px: 1, '& .MuiTab-root': { minHeight: 30, fontSize: 11, py: 0.25, color: '#9aa0b4' }, '& .Mui-selected': { color: '#00ff88 !important' }, '& .MuiTabs-indicator': { bgcolor: '#00ff88' } }}>
        {HANGAR_TABS.map((t) => (
          <Tab key={t.id} data-testid={`hangar-tab-${t.id}`} label={`${t.label} · ${tabReadyCount(t, purse)} ready`} />
        ))}
      </Tabs>
      <Box sx={{ overflowY: 'auto', px: 1, py: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 0.75 }}>
        {tiles.map((t) => (
          <HangarTileCard key={t.id} tile={t} purse={purse} selectedKind={kind} onPick={setKind} />
        ))}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderTop: `1px solid ${EDGE}` }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography data-testid="hangar-cost" sx={{ color: verdict.kind === 'refuse' ? '#ff9a7a' : '#cde', fontSize: 11, fontWeight: 600 }}>{footer.cost}</Typography>
          {(verdict.kind === 'pay' || verdict.kind === 'debt') && (
            <Typography data-testid="hangar-after" sx={{ color: footer.after < 0 ? '#ff7a7a' : '#888', fontSize: 9 }}>
              After launch: {footer.after.toLocaleString('en-GB')} cr
            </Typography>
          )}
        </Box>
        {ownedShipId !== undefined && (
          <Button size="small" data-testid="hangar-abandon" onClick={() => { void abandon(ownedShipId); }} sx={{ color: '#ff9a7a', fontSize: 11 }}>
            Abandon
          </Button>
        )}
        <Button size="small" onClick={onClose} data-testid="hangar-close" sx={{ color: '#9aa0b4', fontSize: 11 }}>Cancel</Button>
        <Button
          size="small" variant="contained" disabled={verdict.kind === 'refuse'} onClick={launch}
          startIcon={<RocketLaunchIcon sx={{ fontSize: 14 }} />} data-testid="hangar-launch"
          sx={{ bgcolor: '#1f7a4d', color: '#fff', fontSize: 11, '&:hover': { bgcolor: '#288c5b' } }}
        >
          Launch
        </Button>
      </Box>
    </Dialog>
  );
}

interface TileProps { tile: HangarTile; purse: HangarPurse; selectedKind: string; onPick: (kind: string) => void }

function HangarTileCard({ tile, purse, selectedKind, onPick }: TileProps): JSX.Element {
  const picked = tile.fits.find((f) => f.kind === selectedKind);
  const shown = picked ?? tile.fits[0]!;
  const v = tileVerdict(shown.kind, purse);
  const owned = tile.fits.some((f) => purse.ownedHere.has(f.kind));
  const label = launchFooter(v, purse.wallet).cost;
  const k = getShipKind(shown.kind);
  return (
    <Box
      data-testid={`ship-card-${tile.id}`}
      data-selected={picked ? '1' : '0'}
      data-owned={owned ? '1' : '0'}
      data-verdict={v.kind}
      sx={{ border: '1px solid', borderColor: owned ? GOLD : picked ? '#1f7a4d' : EDGE, borderRadius: 1, bgcolor: picked ? 'rgba(0,255,136,0.06)' : 'transparent', opacity: v.kind === 'refuse' ? 0.5 : 1 }}
    >
      <ButtonBase onClick={() => onPick(shown.kind)} sx={{ display: 'flex', flexDirection: 'column', width: '100%', p: 0.75 }}>
        <ShipSilhouette shape={k.shape} size={36} />
        <Typography sx={{ color: picked ? '#00ff88' : '#cde', fontSize: 11, fontWeight: 600, lineHeight: 1.1, mt: 0.25 }}>{tile.displayName}</Typography>
        <Typography sx={{ color: owned ? GOLD : '#888', fontSize: 9, lineHeight: 1.1, mt: 0.25 }}>{label}</Typography>
      </ButtonBase>
      {tile.fits.length > 1 && (
        <Box sx={{ display: 'flex', borderTop: `1px solid ${EDGE}` }}>
          {tile.fits.map((f) => (
            <ButtonBase
              key={f.kind} data-testid={`hangar-fit-${f.kind}`} onClick={() => onPick(f.kind)}
              sx={{ flex: 1, py: 0.25, fontSize: 9, color: f.kind === shown.kind && picked ? '#00ff88' : '#9aa0b4', bgcolor: f.kind === shown.kind ? 'rgba(255,255,255,0.05)' : 'transparent' }}
            >
              {FIT_LABEL[f.fit]}
            </ButtonBase>
          ))}
        </Box>
      )}
    </Box>
  );
}
