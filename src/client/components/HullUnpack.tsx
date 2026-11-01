/**
 * Economy v2 W5a — the packed HULLS stored in one of the pilot's own storage
 * structures, each with an Unpack chip. Unpacking turns the crate into a ship
 * parked beside this storage, in your roster; the server checks everything
 * and answers with `blueprint_result` (a toast). Names only, never ids.
 */
import { memo } from 'react';
import { Box, Tooltip } from '@mui/material';
import { parseProduct } from '../../shared-types/blueprints';
import { getShipKind, isPlayableShipKindId } from '../../shared-types/shipKinds';
import { sendUnpackHull } from '../net/tradeClient';

const ROW_SX = { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', pointerEvents: 'auto' as const, mt: 0.5 };
const CHIP_SX = {
  px: 0.75,
  py: '2px',
  borderRadius: '3px',
  border: '1px solid rgba(120,200,255,0.8)',
  color: '#cfeaff',
  backgroundColor: 'rgba(0,24,44,0.6)',
  fontSize: 10,
  cursor: 'pointer',
  userSelect: 'none' as const,
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
    <Box sx={ROW_SX} data-testid="hull-unpack">
      {hulls.map(({ kind, n }) => {
        const name = getShipKind(kind).displayName;
        return (
          <Tooltip key={kind} title={`Unpack a ${name}: it joins your roster, parked here.`}>
            <Box sx={CHIP_SX} data-testid="hull-unpack-chip" data-kind={kind} onClick={() => sendUnpackHull(entityId, kind)}>
              ▢ Unpack {name}{n > 1 ? ` (${n})` : ''}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
});
