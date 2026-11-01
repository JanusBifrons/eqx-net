/**
 * Living World P5 — the blueprints stored in one of the pilot's OWN storage
 * structures, each with an Install button. Installing moves the blueprint
 * from storage onto the pilot's ACTIVE ship (which must be parked next to this
 * storage); the server checks everything and answers with `blueprint_result`
 * (a toast). Names only — never ids.
 */
import { memo } from 'react';
import { Box, Tooltip } from '@mui/material';
import { BLUEPRINTS, isBlueprintId } from '../../shared-types/blueprints';
import { sendInstallBlueprint } from '../net/tradeClient';

const ROW_SX = { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', pointerEvents: 'auto' as const, mt: 0.5 };
const CHIP_SX = {
  px: 0.75,
  py: '2px',
  borderRadius: '3px',
  border: '1px solid rgba(255,200,80,0.8)',
  color: '#ffe6a8',
  backgroundColor: 'rgba(40,28,0,0.6)',
  fontSize: 10,
  cursor: 'pointer',
  userSelect: 'none' as const,
};

export const BlueprintInstall = memo(function BlueprintInstall(
  { entityId, blueprints }: { entityId: number; blueprints: string },
): JSX.Element | null {
  // One chip per distinct blueprint kind (duplicates install one at a time).
  const ids = [...new Set(blueprints.split(',').filter(isBlueprintId))];
  if (ids.length === 0) return null;
  return (
    <Box sx={ROW_SX} data-testid="blueprint-install">
      {ids.map((id) => (
        <Tooltip key={id} title={`${BLUEPRINTS[id].description} Park your ship here, then install.`}>
          <Box
            sx={CHIP_SX}
            data-testid="blueprint-install-chip"
            data-blueprint={id}
            onClick={() => sendInstallBlueprint(entityId, id)}
          >
            ★ Install {BLUEPRINTS[id].displayName}
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
});
