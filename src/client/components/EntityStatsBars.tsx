import { Box, CircularProgress } from '@mui/material';
import { GATE_ACCESS_LABELS } from '@shared-types/gateAccess';
import { hullColor } from '../hud/tokens';
import { Bar } from './inspectorBar';
import { phoneTiny } from './inspectorSizes';
import { ELLIPSIS_SX } from './EntityStatsHeader';
import type { PanelData } from './EntityStatsPanel';

/**
 * Readout rows of the click-to-inspect panel (`EntityStatsPanel`): shield/hull
 * bars (or the info line / pending spinner) for non-structures, the battery
 * charge bar, and the gun / gate readout lines.
 */
export function EntityStatsBars({ data }: { data: PanelData }): JSX.Element {
  const hasCharge = data.storedPowerMax !== undefined && data.storedPowerMax > 0;
  const chargePct = hasCharge ? ((data.storedPower ?? 0) / data.storedPowerMax!) * 100 : 0;
  return (
    <>
      {!data.isStructure &&
        (data.noHull ? (
          // R2.23 — asteroid (size/resources) or lingering hull (owner): no bars.
          <Box sx={INFO_SX} data-testid="entity-stats-info">{data.infoLine}</Box>
        ) : data.pending ? (
          // R2.8 — hp/shield awaiting the first server packet: a spinner, not a 0-bar.
          <Box sx={PENDING_SX} data-testid="entity-stats-spinner">
            <CircularProgress size={12} thickness={6} sx={SPINNER_SX} />
          </Box>
        ) : (
          <>
            {data.shieldPct !== null && (
              <>
                <Cap>SHLD</Cap>
                <Bar pct={data.shieldPct} color={SHIELD_COLOR} />
              </>
            )}
            <Cap>HULL</Cap>
            <Bar pct={data.hpPct} color={hullColor(data.hpPct)} />
          </>
        ))}
      {hasCharge && (
        <>
          <Cap>CHRG</Cap>
          <Bar pct={chargePct} color={CHARGE_COLOR} />
        </>
      )}
      {data.gunLine !== undefined && (
        // Coastal defences — reload + firing arc per gun size.
        <Box sx={GUN_SX} data-testid="entity-stats-guns">
          {data.gunLine}
        </Box>
      )}
      {data.gateAccess !== undefined && (
        // Gates — who it opens for (visible to everyone; only the owner changes it).
        <Box sx={POWER_SX} data-testid="entity-stats-gate-access" data-gate-access={data.gateAccess}>
          {`OPENS FOR ${GATE_ACCESS_LABELS[data.gateAccess]}`}
        </Box>
      )}
      {data.alienGateLine !== undefined && (
        <Box sx={POWER_SX} data-testid="entity-stats-alien-gate">{data.alienGateLine}</Box>
      )}
    </>
  );
}

const SHIELD_COLOR = '#36c8ff';
const CHARGE_COLOR = '#cc8844';

function Cap({ children }: { children: string }): JSX.Element {
  return <Box component="span" sx={CAP_SX}>{children}</Box>;
}

const CAP_SX = {
  ...phoneTiny({ fontSize: [8, 16] }),
  letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.45)',
  textTransform: 'uppercase' as const,
};
const POWER_SX = {
  gridColumn: '1 / -1',
  ...phoneTiny({ fontSize: [8, 16] }),
  fontWeight: 700,
  letterSpacing: 0.4,
  color: 'rgba(180,220,255,0.85)',
  textTransform: 'uppercase' as const,
};
const GUN_SX = {
  gridColumn: '1 / -1',
  ...phoneTiny({ fontSize: [9, 16] }),
  fontWeight: 600,
  letterSpacing: 0.3,
  color: 'rgba(180,220,255,0.85)',
  whiteSpace: 'pre-line' as const,
};
const INFO_SX = {
  gridColumn: '1 / -1',
  ...ELLIPSIS_SX,
  ...phoneTiny({ fontSize: [9, 18] }),
  fontWeight: 600,
  letterSpacing: 0.3,
  color: 'rgba(200,225,255,0.9)',
  whiteSpace: 'nowrap' as const,
};
const PENDING_SX = {
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'center',
  py: '2px',
};
const SPINNER_SX = { color: 'rgba(180,220,255,0.8)' };
