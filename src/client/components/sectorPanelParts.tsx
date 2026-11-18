import { Box, Button, Stack, Typography } from '@mui/material';
import { getShipKind } from '../../shared-types/shipKinds';
import type { RecentCombat, SectorControl, SectorHistorySample } from '../../shared-types/galaxySnapshot';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { entityLabel, type EntityKind } from '../render/entityVisuals';
import { factionColor } from '../render/galaxy/galaxyTerritories';
import { EntityBadge } from './EntityBadge';
import type { SectorShipEntry, SectorTooltipData } from './galaxyTooltip';
import { agoLabel, controlTrend, trendLine, trendShort } from './sectorSparkline';
import { SectorHistorySparkline } from './SectorHistorySparkline';

/**
 * The sector info panel's presentational sections (split out of
 * `SectorInfoDrawer`, which keeps the drawer shell, header and action bar).
 * Each section renders nothing when its data is absent, so the panel never
 * shows an empty heading.
 */

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const SECTION_LABEL_SX = {
  color: '#66ffcc', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', fontFamily: MONO, fontWeight: 700,
} as const;
const SECTION_SX = { mt: 1.25 } as const;
const LINE_SX = { display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 } as const;
const LINE_TEXT_SX = { color: '#cfe', fontSize: 11, lineHeight: 1.3 } as const;
const QUIET_SX = { color: '#7a8499', fontSize: 10 } as const;

/** 0xRRGGBB → "#rrggbb" for the livery colours the map draws with. */
export function cssHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function SectionLabel({ children, right }: { children: string; right?: string | null }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
      <Typography sx={SECTION_LABEL_SX}>{children}</Typography>
      {right ? (
        <Typography data-testid="sector-drawer-trend-short" sx={{ color: '#cfe', fontSize: 9, fontFamily: MONO }} noWrap>
          {right}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * CONTROL: the holder / challenger bar (livery colours, white tick at the
 * boundary), the "who is gaining" line from the last ten history samples, and
 * the last-hour sparkline. Hidden when the feed has no control meter. On a
 * phone the gaining line shrinks to a short label beside the heading.
 */
export function ControlSection({
  tip, samples, compact,
}: {
  tip: SectorTooltipData;
  samples: readonly SectorHistorySample[] | null;
  compact: boolean;
}): JSX.Element | null {
  const c: SectorControl | null = tip.control;
  if (c === null) return null;
  const holderName = tip.holderId !== null ? tip.faction : 'Nobody';
  const trend = samples ? controlTrend(samples) : null;
  const holderPct = Math.max(0, Math.min(100, tip.holderId !== null ? c.holderShare : 0));
  const chPct = c.challenger !== null ? Math.max(0, Math.min(100 - holderPct, c.challengerShare)) : 0;
  const holderColor = cssHex(factionColor(tip.holderId ?? ''));
  return (
    <Box sx={SECTION_SX} data-testid="sector-drawer-control">
      <SectionLabel right={compact && trend ? trendShort(trend, holderName, tip.challenger) : null}>
        {c.locked ? 'Control · locked' : 'Control'}
      </SectionLabel>
      <Box
        data-testid="sector-drawer-control-bar"
        data-holder-share={Math.round(holderPct)}
        data-challenger-share={Math.round(chPct)}
        sx={{ position: 'relative', display: 'flex', height: 8, mt: 0.5, borderRadius: 1, overflow: 'hidden', bgcolor: '#1a2234' }}
      >
        <Box sx={{ width: `${holderPct}%`, bgcolor: holderColor }} />
        <Box sx={{ width: `${chPct}%`, bgcolor: cssHex(factionColor(c.challenger ?? '')) }} />
        {holderPct > 0 && holderPct < 100 && (
          <Box sx={{ position: 'absolute', left: `calc(${holderPct}% - 1px)`, top: 0, bottom: 0, width: 2, bgcolor: '#fff' }} />
        )}
      </Box>
      {!compact && trend && (
        <Typography data-testid="sector-drawer-trend" sx={{ color: '#cfe', fontSize: 11, mt: 0.5 }}>
          {trendLine(trend, holderName, tip.challenger)}
        </Typography>
      )}
      <SectorHistorySparkline samples={samples} color={holderColor} />
    </Box>
  );
}

const STATS: ReadonlyArray<{ kind: EntityKind; label: string; pick: (t: SectorTooltipData) => number }> = [
  { kind: 'ship', label: 'pilots', pick: (t) => t.players },
  { kind: 'hostile', label: 'hostiles', pick: (t) => t.enemies },
  { kind: 'structure', label: 'structures', pick: (t) => t.structures },
  { kind: 'neutral', label: 'neutral drones', pick: (t) => t.neutrals },
];

/** IN THE SECTOR: the 2×2 live-count grid plus any event / capital / elite here. */
export function SectorStats({ tip, compact }: { tip: SectorTooltipData; compact: boolean }): JSX.Element {
  return (
    <Box sx={SECTION_SX}>
      <SectionLabel>In the sector</SectionLabel>
      <Box
        data-testid="sector-drawer-breakdown"
        sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 1, rowGap: compact ? 0.5 : 0.75, mt: 0.5 }}
      >
        {STATS.map((s) => (
          <Box key={s.kind} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <EntityBadge kind={s.kind} size={compact ? 12 : 14} />
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ color: '#dffff0', fontSize: compact ? 15 : 19, fontWeight: 700, lineHeight: 1 }}>
                {s.pick(tip)}
              </Typography>
              <Typography sx={{ color: '#7a8499', fontSize: 8, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: MONO }} noWrap>
                {s.label}
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
      {tip.event !== null && (
        <Typography sx={{ color: '#ff9f43', fontSize: 10, mt: 0.5 }} data-testid="sector-drawer-event">⚑ Event: {tip.event}</Typography>
      )}
      {tip.capital !== null && (
        <Typography sx={{ color: '#9ec9ff', fontSize: 10, mt: 0.5 }} data-testid="sector-drawer-capital">⚓ Capital sighted: the {tip.capital}</Typography>
      )}
      {tip.elite !== null && (
        <Typography sx={{ color: '#ffc850', fontSize: 10, mt: 0.5 }} data-testid="sector-drawer-elite">★ Elite: {tip.elite}</Typography>
      )}
    </Box>
  );
}

/**
 * RECENT: losses in the last five minutes (when any), when the sector last
 * changed hands (when the feed knows), and the player's own ships here with a
 * Spawn button each. `nowMs` is wall time; the feed's `flippedAtMs` is the
 * server's epoch-based game clock, which equals wall time at 1×.
 */
export function RecentSection({
  tip, recentCombat, ships, nowMs, onSpawn,
}: {
  tip: SectorTooltipData;
  recentCombat: RecentCombat | null;
  ships: readonly SectorShipEntry[];
  nowMs: number;
  onSpawn: (shipId: string) => void;
}): JSX.Element {
  const lost = recentCombat !== null && (recentCombat.shipsDestroyed > 0 || recentCombat.structuresDestroyed > 0);
  const flippedAtMs = tip.control?.flippedAtMs ?? null;
  return (
    <Box sx={SECTION_SX} data-testid="sector-drawer-recent">
      <SectionLabel>Recent</SectionLabel>
      {lost && recentCombat.shipsDestroyed > 0 && (
        <LossLine kind="ship" count={recentCombat.shipsDestroyed} />
      )}
      {lost && recentCombat.structuresDestroyed > 0 && (
        <LossLine kind="structure" count={recentCombat.structuresDestroyed} />
      )}
      {flippedAtMs !== null && (
        <Box sx={LINE_SX} data-testid="sector-drawer-flipped">
          <Typography sx={{ color: '#ff9f43', fontSize: 12, width: 14, textAlign: 'center' }}>⇄</Typography>
          <Typography sx={LINE_TEXT_SX}>Last changed hands {agoLabel(nowMs - flippedAtMs)}</Typography>
        </Box>
      )}
      <Box sx={LINE_SX} data-testid="sector-drawer-own-ships">
        <Typography sx={{ color: '#6bff9b', fontSize: 11, width: 14, textAlign: 'center' }}>▲</Typography>
        <Typography sx={ships.length > 0 ? LINE_TEXT_SX : { ...LINE_TEXT_SX, ...QUIET_SX }}>
          {ships.length === 0 ? 'None of your ships here' : `${ships.length} of your ships here`}
        </Typography>
      </Box>
      {ships.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {ships.map((s) => <ShipCard key={s.shipId} ship={s} onSpawn={onSpawn} />)}
        </Stack>
      )}
    </Box>
  );
}

function LossLine({ kind, count }: { kind: EntityKind; count: number }): JSX.Element {
  return (
    <Box sx={LINE_SX}>
      <EntityBadge kind={kind} count={count} size={14} />
      <Typography sx={LINE_TEXT_SX}>
        {entityLabel(kind, count)} destroyed <Box component="span" sx={QUIET_SX}>· last 5 min</Box>
      </Typography>
    </Box>
  );
}

const SHIP_CARD_SX = { display: 'flex', alignItems: 'center', gap: 1, p: 0.5, border: '1px solid #2a3550', borderRadius: 1 } as const;

/** Hull-bar colour by fraction: green (healthy) → amber → red (critical). */
function hullColor(frac: number): string {
  if (frac > 0.5) return '#6bff9b';
  if (frac > 0.2) return '#ffd479';
  return '#ff6b6b';
}

function kindLabel(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** One of the player's ships here: silhouette, hull bar, last position, Spawn. */
function ShipCard({ ship: s, onSpawn }: { ship: SectorShipEntry; onSpawn: (shipId: string) => void }): JSX.Element {
  const kind = getShipKind(s.kind);
  const frac = kind.maxHealth > 0 ? Math.max(0, Math.min(1, s.health / kind.maxHealth)) : 0;
  const pct = Math.round(frac * 100);
  return (
    <Box sx={SHIP_CARD_SX} data-testid={`sector-drawer-ship-${s.shipId}`}>
      <Box sx={{ flex: '0 0 auto', lineHeight: 0 }}>
        <ShipSilhouette shape={kind.shape} size={28} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ color: '#cfe', fontSize: 11, lineHeight: 1.1 }} noWrap>
          {kindLabel(s.kind)}
          {s.isActive ? ' · active' : ''}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
          <Box sx={{ flex: 1, height: 4, borderRadius: 2, bgcolor: '#26304a', overflow: 'hidden' }}>
            <Box
              data-testid={`sector-drawer-hull-${s.shipId}`}
              data-hull-pct={pct}
              sx={{ width: `${pct}%`, height: '100%', bgcolor: hullColor(frac) }}
            />
          </Box>
          <Typography sx={{ color: '#8a93a8', fontSize: 8, flex: '0 0 auto' }}>{pct}%</Typography>
        </Box>
        <Typography sx={{ color: '#7a8499', fontSize: 8, lineHeight: 1.1 }} noWrap>
          ({Math.round(s.x)}, {Math.round(s.y)})
        </Typography>
      </Box>
      <Button
        size="small"
        variant="outlined"
        data-testid={`sector-drawer-spawn-${s.shipId}`}
        onClick={() => onSpawn(s.shipId)}
        sx={{
          flex: '0 0 auto', color: '#cfe', borderColor: '#2a3550', fontSize: 10, py: 0.1, px: 1, textTransform: 'none',
          '&:hover': { borderColor: '#66ffcc' },
        }}
      >
        Spawn
      </Button>
    </Box>
  );
}
