/**
 * Join flow stage 5 — the Hangar: where a pilot picks what to launch into a
 * sector. Built to the approved mock-up: a header (sector, credits, free-
 * launch pips), class tabs with "N ready", square picture tiles on the left
 * (ready hulls, then Shipyard hulls), a detail pane on the right (big
 * picture, fit toggle, hull and speed bars, why-text), and a footer ledger
 * with the cost, the balance after, and LAUNCH. Owned hulls parked here are
 * gold (Launch resumes them; Abandon breaks them up). Every answer comes from
 * `hangarModel` → the shared `launchVerdict`, the same call the server's gate
 * makes. Drawn in the one Window (`EqxWindow`, no title: the Hangar draws
 * its own header and footer); full screen on a phone, centred on desktop.
 */
import { Box, ButtonBase } from '@mui/material';
import { EqxWindow } from '../../../ui/index.js';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SHIP_KIND, getShipKind, type ShipKindId } from '../../../shared-types/shipKinds';
import { FREE_LAUNCHES_START, launchCost } from '../../../shared-types/launch';
import { ShipSilhouette } from '../../render/shipShapeSvg';
import { HullTile, hullArt as art } from '../HullTile';
import { HUD } from '../../hud/tokens';
import { useUIStore } from '../../state/store';
import { fetchEconomy } from '../../net/tradeApi';
import {
  FIT_LABEL, HANGAR_TABS, hangarClassLine, hangarKinds, hangarRole, hangarTiles, hangarWhy,
  launchFooter, tabReadyCount, tileVerdict, type HangarPurse, type HangarTile,
} from './hangarModel';
import { useAbandonShip } from './useAbandonShip';

const C = HUD.color;
/** Two columns above the mock-up's 760 px break; one below. */
const WIDE = '@media (min-width: 761px)';
/** A sideways phone: little height, so the chrome rows tighten. */
const SHORT = '@media (max-height: 500px)';
/** The Hangar's column inside the window: header, tabs, body (scrolls), footer. */
const ROOT_SX = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', color: C.ink, fontFamily: HUD.font.label } as const;
const cr = (n: number): string => n.toLocaleString('en-GB');

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
  /** Signed out and not a remembered guest: the footer asks for sign-in
   *  (or Play as guest) instead of Launch. */
  needsSignIn?: boolean;
  /** Sign in, keeping this sector and hull for the return. */
  onSignIn?: (kind: ShipKindId, sectorKey: string) => void;
  /** Remember the guest choice; the window then launches. */
  onPlayAsGuest?: () => void;
}

export function HangarWindow({ sectorKey, sectorName, playerId, selectedKind, onClose, onLaunchNew, onResume, needsSignIn = false, onSignIn, onPlayAsGuest }: HangarWindowProps): JSX.Element {
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

  /** Bar scales: the toughest and fastest hull in the Hangar. */
  const scale = useMemo(() => {
    let hull = 1, speed = 1;
    for (const k of hangarKinds()) { hull = Math.max(hull, k.maxHealth); speed = Math.max(speed, k.maxSpeed); }
    return { hull, speed };
  }, []);

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
  const ready = tiles.filter((t) => t.fits.some((f) => tileVerdict(f.kind, purse).kind !== 'refuse' || purse.ownedHere.has(f.kind)));
  const yard = tiles.filter((t) => !ready.includes(t));
  const tile = tiles.find((t) => t.fits.some((f) => f.kind === kind)) ?? tiles[0]!;
  const fit = tile.fits.find((f) => f.kind === kind) ?? tile.fits[0]!;
  const verdict = tileVerdict(kind, purse);
  const footer = launchFooter(verdict, purse.wallet);
  const ownedShipId = ownedShips.get(kind);
  const refused = verdict.kind === 'refuse';
  const isCapitalTab = tab.classes.includes('capital');

  // A tab switch moves the pick onto that tab (its first launchable hull), so
  // the footer never prices a ship the pilot can't see.
  const pickTab = (v: number): void => {
    setTabIx(v);
    const t = HANGAR_TABS[v]!;
    const here = hangarTiles(t).flatMap((x) => x.fits.map((f) => f.kind));
    if (here.includes(kind)) return;
    setKind(here.find((k) => tileVerdict(k, purse).kind !== 'refuse') ?? here[0]!);
  };

  const launch = (): void => {
    if (sectorKey === null || refused) return;
    if (ownedShipId !== undefined) onResume(ownedShipId, sectorKey);
    else onLaunchNew(kind as ShipKindId, sectorKey);
  };

  const k = getShipKind(fit.kind);
  const why = hangarWhy(verdict, purse);
  const token = verdict.kind === 'token';
  const costText = token ? '1 free launch' : verdict.kind === 'pay' || verdict.kind === 'debt' ? `${cr(verdict.cost)} cr` : verdict.kind === 'owned' ? 'free (yours)' : 'free';

  return (
    <EqxWindow open={open} onClose={onClose} testId="hangar-window">
      <Box sx={ROOT_SX}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: '14px', py: '10px', borderBottom: `1px solid ${C.panelEdge}`, flexShrink: 0, [SHORT]: { py: '6px' } }}>
          <Box component="h3" sx={{ m: 0, fontSize: 15, fontWeight: 700, letterSpacing: '.02em' }}>Hangar</Box>
          <Box sx={{ fontFamily: HUD.font.num, fontSize: 11, color: C.inkDim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Launching into <Box component="b" sx={{ color: C.ink, fontWeight: 600 }}>{sectorName}</Box>
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, fontFamily: HUD.font.num, fontSize: 13 }}>
            <Box component="span" data-testid="hangar-wallet" sx={{ color: purse.wallet < 0 ? C.danger : C.credits, fontWeight: 600 }}>{cr(purse.wallet)} cr</Box>
            <Box data-testid="hangar-free-launches" data-count={purse.freeLaunches} title="Free capital launches" sx={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              {Array.from({ length: FREE_LAUNCHES_START }, (_, i) => {
                const on = i < purse.freeLaunches;
                return <Box key={i} sx={{ width: 9, height: 9, transform: 'rotate(45deg)', border: `1px solid ${C.auto}`, bgcolor: on ? C.auto : 'transparent', boxShadow: on ? '0 0 6px rgba(52,216,255,.6)' : 'none', opacity: on ? 1 : 0.45 }} />;
              })}
              <Box component="span" sx={{ fontFamily: HUD.font.label, fontSize: 11, color: C.inkDim, ml: '3px', whiteSpace: 'nowrap' }}>free launches</Box>
            </Box>
          </Box>
          <ButtonBase data-testid="hangar-close" aria-label="Close" onClick={onClose} sx={{ width: 26, height: 26, border: `1px solid ${C.panelEdge}`, borderRadius: '4px', color: C.inkDim, fontSize: 13, flexShrink: 0 }}>✕</ButtonBase>
        </Box>

        {/* Tabs */}
        <Box role="tablist" sx={{ display: 'flex', px: '10px', borderBottom: `1px solid ${C.panelEdge}`, flexShrink: 0 }}>
          {HANGAR_TABS.map((t, i) => {
            const sel = i === tabIx;
            return (
              <ButtonBase
                key={t.id} role="tab" aria-selected={sel} data-testid={`hangar-tab-${t.id}`} onClick={() => pickTab(i)}
                sx={{
                  fontFamily: HUD.font.label, fontWeight: 600, fontSize: 13, p: '10px 14px 9px', gap: 1, [SHORT]: { p: '7px 12px 6px' },
                  color: sel ? C.ink : C.inkDim, boxShadow: sel ? `inset 0 -2px 0 ${C.auto}` : 'none',
                  background: sel ? 'linear-gradient(to top, rgba(52,216,255,.08), transparent)' : 'none',
                }}
              >
                {t.label}
                <Box component="span" sx={{ fontFamily: HUD.font.num, fontSize: 10, border: `1px solid ${sel ? C.auto : C.edge2}`, color: sel ? C.auto : C.inkDim, borderRadius: '3px', px: '5px', py: '1px' }}>
                  {tabReadyCount(t, purse)} ready
                </Box>
              </ButtonBase>
            );
          })}
        </Box>

        {/* Body: tiles | detail */}
        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr', overflowY: 'auto', [WIDE]: { gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)', overflowY: 'hidden' } }}>
          <Box sx={{ px: '14px', py: '12px', minHeight: 0, [SHORT]: { py: '8px' }, [WIDE]: { borderRight: `1px solid ${C.panelEdge}`, overflowY: 'auto' } }}>
            {ready.length > 0 && (
              <TileGroup title="Ready to launch" note={isCapitalTab ? (needsSignIn ? 'sign in to launch a capital' : 'launch with credits') : 'free'}>
                {ready.map((t) => <HangarTileCard key={t.id} tile={t} purse={purse} selectedKind={kind} onPick={setKind} />)}
              </TileGroup>
            )}
            {yard.length > 0 && (
              <TileGroup title="Shipyard hulls" note="build or buy at a base">
                {yard.map((t) => <HangarTileCard key={t.id} tile={t} purse={purse} selectedKind={kind} onPick={setKind} />)}
              </TileGroup>
            )}
          </Box>
          <Box data-testid="hangar-detail" sx={{ px: '14px', py: '12px', [SHORT]: { py: '8px', gap: '8px' }, display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, [WIDE]: { overflowY: 'auto' } }}>
            <Box sx={{ position: 'relative', aspectRatio: '16 / 10', maxHeight: '42vh', [SHORT]: { maxHeight: '30vh' }, borderRadius: '8px', border: `1px solid ${C.panelEdge}`, bgcolor: '#020309', backgroundImage: art(fit.kind) ?? 'none', backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {art(fit.kind) === null && <ShipSilhouette shape={k.shape} size={96} />}
              <Box component="span" sx={{ position: 'absolute', top: 8, left: 10, fontFamily: HUD.font.num, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: C.inkDim }}>
                {hangarClassLine(tile, fit, verdict)}
              </Box>
              <Box component="span" sx={{ position: 'absolute', bottom: 8, left: 10, fontSize: 22, fontWeight: 700, textShadow: '0 2px 8px rgba(0,0,0,.8)' }}>{tile.displayName}</Box>
            </Box>
            {tile.fits.length > 1 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {tile.fits.map((f) => {
                  const on = f.kind === fit.kind;
                  return (
                    <ButtonBase
                      key={f.kind} data-testid={`hangar-fit-${f.kind}`} aria-pressed={on} onClick={() => setKind(f.kind)}
                      sx={{ fontFamily: HUD.font.label, fontWeight: 600, fontSize: 11, p: '3px 8px', borderRadius: '4px', border: `1px solid ${on ? C.auto : C.edge2}`, bgcolor: on ? 'rgba(52,216,255,.12)' : 'transparent', color: on ? C.ink : C.inkDim, minHeight: 28 }}
                    >
                      {FIT_LABEL[f.fit]}
                    </ButtonBase>
                  );
                })}
              </Box>
            )}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <StatRow label="Hull" value={k.maxHealth} pct={Math.max(3, Math.sqrt(k.maxHealth / scale.hull) * 100)} color={C.hullOk} />
              <StatRow label="Speed" value={k.maxSpeed} pct={Math.max(3, (k.maxSpeed / scale.speed) * 100)} color={C.auto} />
            </Box>
            <Box component="p" sx={{ m: 0, fontSize: 12, color: C.inkDim, lineHeight: 1.4 }}>{hangarRole(tile, k.description)}</Box>
            {why !== null && (
              <Box component="p" sx={{ m: 0, fontSize: 12, color: why.warn ? C.manual : C.inkDim, lineHeight: 1.4 }}>{why.text}</Box>
            )}
            {ownedShipId !== undefined && (
              <ButtonBase data-testid="hangar-abandon" onClick={() => { void abandon(ownedShipId); }} sx={{ alignSelf: 'flex-start', fontFamily: HUD.font.label, fontWeight: 600, fontSize: 11, color: C.danger, border: `1px solid rgba(255,77,106,.4)`, borderRadius: '4px', p: '5px 10px', minHeight: 30 }}>
                Abandon this ship
              </ButtonBase>
            )}
          </Box>
        </Box>

        {/* Footer */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: '14px', py: '10px', borderTop: `1px solid ${C.panelEdge}`, flexShrink: 0, [SHORT]: { py: '6px' } }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: '2px', fontFamily: HUD.font.num, fontSize: 12, color: C.inkDim, minWidth: 0 }}>
            {refused ? (
              <Box component="span" data-testid="hangar-cost" data-cost={footer.cost}>Can&apos;t launch this from here</Box>
            ) : (
              <>
                <Box component="span">Cost <Box component="b" data-testid="hangar-cost" data-cost={footer.cost} sx={{ color: C.ink, fontWeight: 600 }}>{costText}</Box></Box>
                <Box component="span">After launch <Box component="b" data-testid="hangar-after" sx={{ color: footer.after < 0 ? C.danger : C.credits, fontWeight: 600 }}>{cr(footer.after)} cr</Box>
                  {token && <> · <Box component="b" sx={{ color: C.ink }}>{Math.max(0, purse.freeLaunches - 1)}</Box> free left</>}
                </Box>
              </>
            )}
          </Box>
          <Box sx={{ flex: 1 }} />
          {needsSignIn ? (
            <>
              <ButtonBase data-testid="hangar-guest" disabled={refused} onClick={() => { onPlayAsGuest?.(); launch(); }} sx={altBtn}>Play as guest</ButtonBase>
              <ButtonBase data-testid="hangar-signin" onClick={() => { if (sectorKey !== null) onSignIn?.(kind as ShipKindId, sectorKey); }} sx={launchBtn(false)}>SIGN IN TO LAUNCH ▸</ButtonBase>
            </>
          ) : (
            <>
              <ButtonBase onClick={onClose} sx={altBtn}>Back to map</ButtonBase>
              <ButtonBase data-testid="hangar-launch" disabled={refused} onClick={launch} sx={launchBtn(refused)}>{refused ? 'LAUNCH' : 'LAUNCH ▸'}</ButtonBase>
            </>
          )}
        </Box>
      </Box>
    </EqxWindow>
  );
}

const altBtn = {
  fontFamily: HUD.font.label, fontWeight: 600, fontSize: 12, color: C.ink, p: '9px 12px', minHeight: HUD.touchMin,
  border: `1px solid ${C.edge2}`, borderRadius: '4px', whiteSpace: 'nowrap', '&.Mui-disabled': { color: C.inkFaint },
} as const;

const launchBtn = (off: boolean) => ({
  fontFamily: HUD.font.label, fontWeight: 700, fontSize: 14, letterSpacing: '.08em', px: '22px', minHeight: HUD.touchMin,
  borderRadius: '4px', whiteSpace: 'nowrap', color: off ? C.inkFaint : '#04121a', bgcolor: off ? 'rgba(52,216,255,.18)' : C.auto,
  boxShadow: off ? 'none' : '0 0 14px rgba(52,216,255,.35)',
}) as const;

function TileGroup({ title, note, children }: { title: string; note: string; children: ReactNode }): JSX.Element {
  return (
    <Box sx={{ mb: '12px' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, fontFamily: HUD.font.num, fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: C.inkFaint, mb: '7px' }}>
        <span>{title}</span><span>{note}</span>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '6px' }}>{children}</Box>
    </Box>
  );
}

function StatRow({ label, value, pct, color }: { label: string; value: number; pct: number; color: string }): JSX.Element {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '62px 1fr 56px', alignItems: 'center', gap: 1, fontSize: 11, color: C.inkDim }}>
      <span>{label}</span>
      <Box sx={{ height: 5, borderRadius: '3px', bgcolor: 'rgba(160,200,255,.1)', overflow: 'hidden' }}>
        <Box sx={{ width: `${Math.min(100, pct)}%`, height: '100%', bgcolor: color }} />
      </Box>
      <Box component="span" sx={{ fontFamily: HUD.font.num, textAlign: 'right', color: C.ink }}>{cr(Math.round(value))}</Box>
    </Box>
  );
}

interface TileProps { tile: HangarTile; purse: HangarPurse; selectedKind: string; onPick: (kind: string) => void }

function HangarTileCard({ tile, purse, selectedKind, onPick }: TileProps): JSX.Element {
  const picked = tile.fits.find((f) => f.kind === selectedKind);
  const shown = picked ?? tile.fits[0]!;
  const v = tileVerdict(shown.kind, purse);
  const owned = tile.fits.some((f) => purse.ownedHere.has(f.kind));
  const locked = v.kind === 'refuse' && v.reason === 'shipyard';
  const cap = tile.sizeClass === 'capital' && !locked;
  const price = locked ? { text: 'Shipyard', color: C.danger }
    : owned ? { text: 'Owned', color: C.tier2 }
    : v.kind === 'free' ? { text: 'Free', color: C.hullOk }
    : { text: `${cr(launchCost(shown.kind))} cr`, color: C.credits };
  const edge = picked ? C.auto : owned ? C.tier2 : cap ? C.tier1 : C.edge2;
  const glow = picked ? `0 0 0 1px ${C.auto}, 0 0 14px rgba(52,216,255,.35)` : owned ? 'inset 0 0 12px rgba(255,200,58,.22)' : cap ? 'inset 0 0 10px rgba(74,168,255,.18)' : 'none';
  return (
    <HullTile
      kind={shown.kind} name={tile.displayName} testId={`ship-card-${tile.id}`}
      data={{ selected: picked ? '1' : '0', owned: owned ? '1' : '0', verdict: v.kind }}
      edge={edge} glow={glow} pressed={!!picked} dim={locked} caption={price}
      tag={tile.fits.length > 1 ? `${tile.fits.length} fits` : undefined}
      onClick={() => onPick(shown.kind)}
    />
  );
}
