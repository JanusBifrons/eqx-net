import { useMemo } from 'react';
import {
  GALAXY_SECTORS,
  axialToPixel,
  type GalaxySector,
} from '../../core/galaxy/galaxy';

const HEX_SIZE = 78;        // pixel size of one hex (centre to vertex)
const PADDING = 24;         // viewBox padding around the bounding cluster

interface HexGalaxyMapProps {
  /** Sector keys the user is allowed to click. Empty = all dimmed. */
  selectableKeys: readonly string[];
  /** Sector to highlight as "you are here" / "your ship is here". */
  highlightKey?: string | null;
  /** Click handler. Only fires when `key` is in `selectableKeys`. */
  onSelect: (key: string) => void;
}

/** Standard pointy-top hex polygon path centred at (0, 0) with radius `size`. */
function hexPoints(size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3; // 30°, 90°, 150°, ...
    pts.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}

interface HexProps {
  sector: GalaxySector;
  cx: number;
  cy: number;
  selectable: boolean;
  highlighted: boolean;
  onSelect: (key: string) => void;
}

function Hex({ sector, cx, cy, selectable, highlighted, onSelect }: HexProps): JSX.Element {
  const fill = highlighted
    ? '#00ff88'
    : selectable
    ? '#0a3322'
    : '#161a26';
  const stroke = highlighted
    ? '#00ff88'
    : selectable
    ? '#1f7a4d'
    : '#2a2f40';
  const textColor = selectable || highlighted ? '#00ff88' : '#888';
  const cursor = selectable ? 'pointer' : 'default';
  const opacity = selectable || highlighted ? 1 : 0.55;

  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      onClick={() => { if (selectable) onSelect(sector.key); }}
      style={{ cursor, opacity, transition: 'opacity 200ms' }}
      data-sector-key={sector.key}
      data-selectable={selectable ? '1' : '0'}
      data-highlighted={highlighted ? '1' : '0'}
    >
      <polygon
        points={hexPoints(HEX_SIZE)}
        fill={fill}
        stroke={stroke}
        strokeWidth={highlighted ? 3 : 1.5}
        style={selectable ? { transition: 'fill 150ms, stroke 150ms' } : undefined}
      />
      <text
        x={0}
        y={-6}
        textAnchor="middle"
        fill={textColor}
        fontSize={13}
        fontWeight={700}
        style={{ pointerEvents: 'none', textTransform: 'uppercase', letterSpacing: 1 }}
      >
        {sector.name}
      </text>
      <text
        x={0}
        y={14}
        textAnchor="middle"
        fill="#9aa0b4"
        fontSize={9}
        style={{ pointerEvents: 'none' }}
      >
        {sector.neighbours.length} link{sector.neighbours.length === 1 ? '' : 's'}
      </text>
    </g>
  );
}

/**
 * Reusable SVG hex map of the galaxy. Used both as the landing screen
 * (selectable = all keys, highlight = none) and as the in-game galaxy-map
 * overlay (selectable = current sector's neighbours, highlight = current).
 *
 * Renders the seven `GALAXY_SECTORS` positioned by axial-hex coordinates and
 * draws line segments between every neighbour pair (deduped by key ordering).
 */
export function HexGalaxyMap({
  selectableKeys,
  highlightKey,
  onSelect,
}: HexGalaxyMapProps): JSX.Element {
  // Pre-compute screen-space pixel positions for each sector.
  const placed = useMemo(
    () =>
      GALAXY_SECTORS.map((s) => ({
        sector: s,
        ...axialToPixel(s.hex, HEX_SIZE),
      })),
    [],
  );

  // Bounding box (with a hex's worth of padding around the outermost vertex).
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of placed) {
      minX = Math.min(minX, p.x - HEX_SIZE);
      maxX = Math.max(maxX, p.x + HEX_SIZE);
      minY = Math.min(minY, p.y - HEX_SIZE);
      maxY = Math.max(maxY, p.y + HEX_SIZE);
    }
    return {
      x: minX - PADDING,
      y: minY - PADDING,
      w: (maxX - minX) + PADDING * 2,
      h: (maxY - minY) + PADDING * 2,
    };
  }, [placed]);

  // Edge segments — dedupe by sorting the key pair.
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ x1: number; y1: number; x2: number; y2: number; faded: boolean }> = [];
    for (const p of placed) {
      for (const nKey of p.sector.neighbours) {
        const a = p.sector.key;
        const b = nKey;
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const target = placed.find((q) => q.sector.key === nKey);
        if (!target) continue;
        // Edge is "active" if both endpoints are selectable or one is the highlight.
        const aActive = selectableKeys.includes(a) || a === highlightKey;
        const bActive = selectableKeys.includes(b) || b === highlightKey;
        out.push({ x1: p.x, y1: p.y, x2: target.x, y2: target.y, faded: !(aActive && bActive) });
      }
    }
    return out;
  }, [placed, selectableKeys, highlightKey]);

  const selSet = useMemo(() => new Set(selectableKeys), [selectableKeys]);

  return (
    <svg
      data-testid="hex-galaxy-map"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      {edges.map((e, i) => (
        <line
          key={i}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke={e.faded ? '#2a2f40' : '#1f7a4d'}
          strokeWidth={1.5}
          strokeDasharray={e.faded ? '4 4' : undefined}
        />
      ))}
      {placed.map((p) => (
        <Hex
          key={p.sector.key}
          sector={p.sector}
          cx={p.x}
          cy={p.y}
          selectable={selSet.has(p.sector.key)}
          highlighted={p.sector.key === highlightKey}
          onSelect={onSelect}
        />
      ))}
    </svg>
  );
}
