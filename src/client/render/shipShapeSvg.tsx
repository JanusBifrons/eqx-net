import type { ShipShape } from '../../shared-types/shipKinds';

interface ShipSilhouetteProps {
  shape: ShipShape;
  /** SVG viewbox half-width / half-height in entity-local units. Default 20
   *  fits all v1 catalogue shapes (largest extent is Heavy at ±14). */
  viewBoxHalf?: number;
  /** Pixel size of the rendered SVG. Square. */
  size?: number;
}

/**
 * Draw a ship's catalogue silhouette as an SVG element. The picker uses this
 * for the per-card preview and the bottom-right trigger thumbnail; the
 * in-game Pixi sprite uses the same point list (see
 * `buildShipGfxFromShape` in `PixiRenderer.ts`) so the picker and the
 * in-world ship can never disagree.
 *
 * The SVG y-axis is inverted relative to Pixi's local-space convention (Pixi
 * draws the polygon with nose at -y and tail at +y, matching Rapier's Y-up
 * world; SVG's y grows downward). Handled by the polygon-points string —
 * each point's y is negated so the picker shows the nose pointing UP, same
 * as a screen-space top-down view of an in-game ship at angle=0.
 */
export function ShipSilhouette({
  shape,
  viewBoxHalf = 20,
  size = 64,
}: ShipSilhouetteProps): JSX.Element | null {
  // Composite-shape silhouettes land in Phase 1; no catalogue kind uses the
  // composite variant in Phase 0, so this branch is unreachable today. Narrow
  // to the polygon variant for the body below.
  if (shape.kind !== 'polygon') return null;
  const points = shape.points
    .map(([x, y]) => `${x * shape.scale},${-y * shape.scale}`)
    .join(' ');
  const colorHex = `#${shape.color.toString(16).padStart(6, '0')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-${viewBoxHalf} -${viewBoxHalf} ${viewBoxHalf * 2} ${viewBoxHalf * 2}`}
      aria-hidden="true"
    >
      <polygon points={points} fill={colorHex} />
    </svg>
  );
}
