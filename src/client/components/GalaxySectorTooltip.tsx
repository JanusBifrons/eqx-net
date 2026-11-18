/**
 * Living Galaxy Phase 6 — sector tooltip on desktop hover. Anchored
 * ABOVE-CENTRE of the hovered hex (Equinox Phase 9); non-interactive.
 * Sector name + faction + status + live counts (icons) + features, from the
 * static graph + the /galaxy/snapshot slice. Kept on desktop alongside the
 * click-selected drawer (the doc: "desktop keeps the tooltips"). The caller
 * gates it out on touch. Extension point of `GalaxyPickerChrome`.
 */
import { Box, Typography } from '@mui/material';
import { ownerLine } from './galaxyTooltip';
import type { buildSectorTooltip } from './galaxyTooltip';

type SectorTip = NonNullable<ReturnType<typeof buildSectorTooltip>>;

export interface GalaxySectorTooltipProps {
  /** The hovered hex's TOP-centre in screen space, plus its sector key. */
  hover: { sectorKey: string; left: number; top: number };
  tip: SectorTip;
}

export function GalaxySectorTooltip({ hover, tip: sectorTip }: GalaxySectorTooltipProps): JSX.Element {
  return (
    <Box
      data-testid="galaxy-sector-tooltip"
      data-tooltip-sector={hover.sectorKey}
      sx={{
        position: 'fixed',
        // Equinox Phase 9 — anchored ABOVE-CENTRE of the hex. galaxyHover now
        // carries the hex's TOP-centre (GalaxyMapLayer.updateHover), so centre
        // the tooltip horizontally on it and float it just above (vs the old
        // down-right-of-cursor offset). `textAlign:center` keeps the copy tidy
        // under the centred anchor.
        left: hover.left,
        top: hover.top,
        transform: 'translate(-50%, calc(-100% - 6px))',
        textAlign: 'center',
        zIndex: 5,
        pointerEvents: 'none',
        bgcolor: 'rgba(8,12,24,0.94)',
        border: '1px solid #2a3550',
        borderRadius: 1,
        px: 1,
        py: 0.75,
        maxWidth: 220,
      }}
    >
      <Typography sx={{ color: '#dffff0', fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>
        {sectorTip.name}
      </Typography>
      <Typography sx={{ color: '#8fe9c0', fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {ownerLine(sectorTip)}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, flexWrap: 'wrap' }}>
        {sectorTip.players > 0 && (
          <Typography sx={{ color: '#6bff9b', fontSize: 10 }} title="Players">▲ {sectorTip.players}</Typography>
        )}
        {sectorTip.enemies > 0 && (
          <Typography sx={{ color: '#ff6b6b', fontSize: 10 }} title="Hostiles">✦ {sectorTip.enemies}</Typography>
        )}
        {sectorTip.neutrals > 0 && (
          <Typography sx={{ color: '#ffd479', fontSize: 10 }} title="Neutrals">◇ {sectorTip.neutrals}</Typography>
        )}
        {sectorTip.structures > 0 && (
          <Typography sx={{ color: '#9ab4dd', fontSize: 10 }} title="Structures">⬡ {sectorTip.structures}</Typography>
        )}
        {sectorTip.players + sectorTip.enemies + sectorTip.neutrals + sectorTip.structures === 0 && (
          <Typography sx={{ color: '#6b7280', fontSize: 10 }}>no activity</Typography>
        )}
      </Box>
      {sectorTip.event !== null && (
        <Typography sx={{ color: '#ff9f43', fontSize: 10, mt: 0.25 }} data-testid="galaxy-tooltip-event">
          ⚑ {sectorTip.event} underway
        </Typography>
      )}
      {sectorTip.capital !== null && (
        <Typography sx={{ color: '#9ec9ff', fontSize: 10, mt: 0.25 }} data-testid="galaxy-tooltip-capital">
          ⚓ Capital sighted: the {sectorTip.capital}
        </Typography>
      )}
      {sectorTip.elite !== null && (
        <Typography sx={{ color: '#ffc850', fontSize: 10, mt: 0.25 }} data-testid="galaxy-tooltip-elite">
          ★ {sectorTip.elite} sighted
        </Typography>
      )}
      {sectorTip.features.length > 0 && (
        <Typography sx={{ color: '#7a8499', fontSize: 9, mt: 0.25, textTransform: 'capitalize' }}>
          {sectorTip.features.join(' · ')}
        </Typography>
      )}
    </Box>
  );
}
