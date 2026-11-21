/**
 * One square hull picture tile, shared by the Hangar (pick a hull to launch)
 * and a shipyard's Build tab (queue hulls to build). The portrait comes from
 * `shipPortraitUrl`; a kind with no portrait draws its silhouette. The name
 * sits over a bottom fade with an optional caption under it (the Hangar's
 * price); optional slots: a top-right tag ("2 fits"), a top-left ×N badge,
 * a lock overlay, a progress fill, a row under the picture (children,
 * e.g. CostChips), and a desktop hover tooltip (never opened by touch).
 *
 * `art="structure"` draws a building instead (the Build menu's kind tiles):
 * its baked portrait (`structurePortraitUrl`), or, when there is none or the
 * image fails to load, its footprint drawn from `structureHullPoints`.
 */
import { Box, ButtonBase, Tooltip } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { useState, type PointerEventHandler, type ReactNode } from 'react';
import { getShipKind } from '../../shared-types/shipKinds';
import { getStructureKind, structureHullPoints } from '../../shared-types/structureKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { shipPortraitUrl, structurePortraitUrl } from '../render/art/shipPortraits';
import { HUD } from '../hud/tokens';
import { useHudSize } from '../hud/useHudScale';

const C = HUD.color;

/** Picture for a kind as a CSS background, or null (silhouette fallback). */
export function hullArt(kind: string): string | null {
  const u = shipPortraitUrl(kind);
  return u === null ? null : `url("${u}")`;
}

/** A building's footprint silhouette (game space Y-up → SVG Y-down), in its catalogue colour. */
export function StructureSilhouette({ kind, size = 44 }: { kind: string; size?: number }): JSX.Element {
  const pts = structureHullPoints(kind);
  const half = Math.max(1, ...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 1.1;
  const color = `#${getStructureKind(kind).color.toString(16).padStart(6, '0')}`;
  return (
    <svg width={size} height={size} viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} aria-hidden="true" data-testid="hull-tile-silhouette">
      <polygon points={pts.map((p) => `${p.x},${-p.y}`).join(' ')} fill={color} />
    </svg>
  );
}

export interface HullTileProps {
  /** Ship (or, with `art="structure"`, structure) kind: the portrait (or silhouette) drawn. */
  kind: string;
  /** What `kind` names: a ship hull (default) or a building. */
  art?: 'ship' | 'structure';
  name: string;
  /** Test id and data attributes on the tile's outer box. */
  testId: string;
  data?: Readonly<Record<string, string>>;
  /** Edge colour and box shadow (selection, owned, capital...). */
  edge?: string;
  glow?: string;
  pressed?: boolean;
  /** Small line under the name (the Hangar's price). */
  caption?: { text: string; color: string };
  /** Top-right tag ("2 fits"). */
  tag?: string;
  /** Top-left badge ("×3", "∞"). */
  badge?: string;
  /** Greyed with a lock: no blueprint for this hull. */
  locked?: boolean;
  /** Greyed without a lock (the Hangar's Shipyard-only hulls). */
  dim?: boolean;
  /** 0..1 build progress, drawn as a fill; undefined = none. */
  progress?: number;
  /** Desktop hover text (name, cost, lock reason); touch never opens it. */
  tooltip?: string;
  /** A row under the picture (e.g. CostChips). */
  children?: ReactNode;
  onClick?: () => void;
  onPointerDown?: PointerEventHandler;
  onPointerUp?: PointerEventHandler;
  onPointerLeave?: PointerEventHandler;
  onPointerEnter?: PointerEventHandler;
}

export function HullTile({
  kind, name, testId, data, edge = C.edge2, glow = 'none', pressed, caption, tag, badge, locked = false, dim = false,
  progress, tooltip, children, onClick, onPointerDown, onPointerUp, onPointerLeave, onPointerEnter, art = 'ship',
}: HullTileProps): JSX.Element {
  // A tap on a touch screen also fires a mouse hover: tooltips are desk-only.
  const noHover = useHudSize() !== 'desk';
  const [imgFailed, setImgFailed] = useState(false);
  const structUrl = art === 'structure' && !imgFailed ? structurePortraitUrl(kind) : null;
  const pic = art === 'ship' ? hullArt(kind) : null;
  const noPicture = pic === null && structUrl === null;
  const grey = locked || dim;
  const dataAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) dataAttrs[`data-${k}`] = v;
  const tile = (
      <ButtonBase
        onClick={onClick} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerLeave={onPointerLeave}
        onPointerEnter={onPointerEnter} aria-pressed={pressed} aria-label={name}
        sx={{
          position: 'relative', display: 'block', width: '100%', aspectRatio: '1 / 1', borderRadius: '6px', overflow: 'hidden',
          border: `1px solid ${edge}`, boxShadow: glow, bgcolor: C.cell,
          backgroundImage: pic ?? 'none', backgroundSize: '128%', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
          filter: grey ? 'grayscale(.85) brightness(.55)' : 'none', textAlign: 'left',
          '&::after': { content: '""', position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 45%, rgba(4,6,13,.92))', pointerEvents: 'none' },
        }}
      >
        {structUrl !== null && (
          <Box component="img" src={structUrl} alt="" draggable={false} data-testid="hull-tile-portrait" onError={() => setImgFailed(true)}
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
        )}
        {noPicture && (
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pb: '18px' }}>
            {art === 'structure' ? <StructureSilhouette kind={kind} /> : <ShipSilhouette shape={getShipKind(kind).shape} size={44} />}
          </Box>
        )}
        {progress !== undefined && (
          <Box data-testid="hull-tile-progress" data-frac={progress.toFixed(2)} sx={{
            position: 'absolute', left: 0, bottom: 0, top: 0, zIndex: 1, width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`,
            bgcolor: 'rgba(52,216,255,.16)', borderRight: `2px solid ${C.auto}`, pointerEvents: 'none',
          }} />
        )}
        {badge !== undefined && (
          <Box component="span" data-testid="hull-tile-badge" sx={{ position: 'absolute', top: 5, left: 5, zIndex: 1, fontFamily: HUD.font.num, fontSize: 11, fontWeight: 700, color: '#04121a', bgcolor: C.auto, borderRadius: '3px', px: '5px', lineHeight: '16px' }}>
            {badge}
          </Box>
        )}
        {tag !== undefined && (
          <Box component="span" sx={{ position: 'absolute', top: 5, right: 5, zIndex: 1, fontFamily: HUD.font.num, fontSize: 9, color: C.inkDim, border: `1px solid ${C.edge2}`, borderRadius: '3px', px: '4px', bgcolor: 'rgba(4,6,13,.6)' }}>
            {tag}
          </Box>
        )}
        {locked && (
          <Box data-testid="hull-tile-lock" sx={{ position: 'absolute', inset: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', pb: '18px', color: C.ink }}>
            <LockIcon sx={{ fontSize: 26 }} />
          </Box>
        )}
        <Box component="span" sx={{ position: 'absolute', bottom: caption ? 18 : 6, left: 6, right: 6, zIndex: 1, fontFamily: HUD.font.label, fontWeight: 600, fontSize: 11.5, color: C.ink, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </Box>
        {caption && <Box component="span" sx={{ position: 'absolute', bottom: 5, left: 6, zIndex: 1, fontFamily: HUD.font.num, fontSize: 10, color: caption.color }}>{caption.text}</Box>}
      </ButtonBase>
  );
  return (
    <Box data-testid={testId} {...dataAttrs}>
      {tooltip === undefined ? tile : <Tooltip title={tooltip} describeChild disableTouchListener disableHoverListener={noHover} disableFocusListener={noHover}>{tile}</Tooltip>}
      {children !== undefined && <Box sx={{ mt: '3px' }}>{children}</Box>}
    </Box>
  );
}
