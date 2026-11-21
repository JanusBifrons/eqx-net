/**
 * Economy v2 W5a — the packed HULLS stored in one of the pilot's own storage
 * structures, one shared `HullTile` per kind (portrait, name, ×n count) in
 * the Build tab's tile grid. Tapping a tile unpacks one: the crate becomes a
 * ship parked beside this storage, in your roster; the server checks
 * everything and answers with `blueprint_result` (a toast). Names only,
 * never ids.
 */
import { memo } from 'react';
import { Box, Tooltip } from '@mui/material';
import { parseProduct } from '../../shared-types/blueprints';
import { getShipKind, isPlayableShipKindId } from '../../shared-types/shipKinds';
import { sendUnpackHull } from '../net/tradeClient';
import { HullTile } from './HullTile';
import { HUD } from '../hud/tokens';

/** Same grid as the Build tab's hull tiles. */
const GRID_SX = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '6px', pointerEvents: 'auto' as const, mt: 0.5,
};

/** The distinct hull kinds in a comma-joined packed-product list, with counts. */
export function packedHullsOf(packed: string): Array<{ kind: string; n: number }> {
  const counts = new Map<string, number>();
  for (const p of packed.split(',')) {
    const { ns, id } = parseProduct(p);
    if (ns === 'hull' && isPlayableShipKindId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => ({ kind, n }));
}

export const HullUnpack = memo(function HullUnpack(
  { entityId, packed }: { entityId: number; packed: string },
): JSX.Element | null {
  const hulls = packedHullsOf(packed);
  if (hulls.length === 0) return null;
  return (
    <Box sx={GRID_SX} data-testid="hull-unpack">
      {hulls.map(({ kind, n }) => {
        const name = getShipKind(kind).displayName;
        return (
          <Tooltip key={kind} title={`Unpack a ${name}: it joins your roster, parked here.`}>
            <Box>
              <HullTile
                kind={kind} name={name} testId="hull-unpack-chip" data={{ kind }}
                badge={`×${n}`} caption={{ text: 'Unpack', color: HUD.color.auto }}
                onClick={() => sendUnpackHull(entityId, kind)}
              />
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
});
