import { useEffect, useState, type JSX } from 'react';
import { Box } from '@mui/material';
import type { ShipRenderState } from '../../core/index.js';
import { useUIStore } from '../state/store.js';

export interface ShipStatsCardProps {
  /** Returns the local player's render-mirror entry, or null if not yet available.
   *  Spatial state must NOT be in Zustand (project invariant #2), so the card
   *  samples the mirror via this stable getter. */
  getLocalShip: () => ShipRenderState | null;
}

interface SpatialSnapshot {
  x: number;
  y: number;
  speed: number;
  headingDeg: number;
}

const SAMPLE_HZ = 5;

function hullColor(pct: number): string {
  if (pct <= 25) return '#ff5252';
  if (pct <= 50) return '#ffb74d';
  return '#7cd778';
}

function angleToHeading(angleRad: number): number {
  const deg = ((angleRad * 180) / Math.PI) % 360;
  return deg < 0 ? deg + 360 : deg;
}

export function ShipStatsCard({ getLocalShip }: ShipStatsCardProps): JSX.Element {
  const hullPct = useUIStore((s) => s.hullPct);
  const ammo = useUIStore((s) => s.ammo);

  const [spatial, setSpatial] = useState<SpatialSnapshot | null>(null);

  useEffect(() => {
    const tick = (): void => {
      const ship = getLocalShip();
      if (!ship) {
        setSpatial(null);
        return;
      }
      const next: SpatialSnapshot = {
        x: Math.round(ship.x),
        y: Math.round(ship.y),
        speed: Math.round(Math.hypot(ship.vx, ship.vy)),
        headingDeg: Math.round(angleToHeading(ship.angle)),
      };
      setSpatial((prev) => {
        if (
          prev &&
          prev.x === next.x &&
          prev.y === next.y &&
          prev.speed === next.speed &&
          prev.headingDeg === next.headingDeg
        ) {
          return prev;
        }
        return next;
      });
    };
    tick();
    const id = window.setInterval(tick, 1000 / SAMPLE_HZ);
    return () => window.clearInterval(id);
  }, [getLocalShip]);

  return (
    <Box
      data-testid="ship-stats-card"
      sx={{
        bgcolor: 'rgba(0,0,0,0.72)',
        color: '#dde',
        fontFamily: 'monospace',
        fontSize: 11,
        p: 1,
        borderRadius: 1,
        pointerEvents: 'none',
        lineHeight: 1.5,
        minWidth: 180,
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Row label="Hull" value={`${hullPct}%`} valueColor={hullColor(hullPct)} testid="ship-stats-hull" />
      <Row label="Ammo" value={String(ammo)} testid="ship-stats-ammo" />
      <Row
        label="X"
        value={spatial ? String(spatial.x) : '—'}
        testid="ship-stats-x"
      />
      <Row
        label="Y"
        value={spatial ? String(spatial.y) : '—'}
        testid="ship-stats-y"
      />
      <Row
        label="Speed"
        value={spatial ? `${spatial.speed} u/s` : '—'}
        testid="ship-stats-speed"
      />
      <Row
        label="Heading"
        value={spatial ? `${spatial.headingDeg}°` : '—'}
        testid="ship-stats-heading"
      />
    </Box>
  );
}

interface RowProps {
  label: string;
  value: string;
  valueColor?: string;
  testid?: string;
}

function Row({ label, value, valueColor, testid }: RowProps): JSX.Element {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span data-testid={testid} style={{ color: valueColor ?? '#fff' }}>
        {value}
      </span>
    </Box>
  );
}
