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
  if (shape.kind === 'composite') {
    return <CompositeSilhouette shape={shape} viewBoxHalf={viewBoxHalf} size={size} />;
  }
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

/** 24-bit RGB integer → `#rrggbb`. */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * Composite-shape silhouette (composite-ships Phase 1). Each part renders as an
 * SVG `<polygon>` with its transformed/scaled points (Y negated for the SVG
 * screen frame, exactly like the polygon branch), filled with the part colour
 * and optionally stroked. Parts are drawn in catalogue order so later parts
 * (cockpit body, dome) layer on top.
 *
 * The viewBox is sized to the gross `hull` (its max scaled extent on either
 * axis) so the whole silhouette fits with a small margin — mirrors the polygon
 * branch's centred-at-origin convention.
 */
function CompositeSilhouette({
  shape,
  viewBoxHalf,
  size,
}: {
  shape: import('../../shared-types/shipKinds').ShipCompositeShape;
  viewBoxHalf: number;
  size: number;
}): JSX.Element {
  const scale = shape.scale;
  // Fit the viewBox to the hull extent (scaled). Fall back to the default half
  // if the hull is degenerate.
  let maxExtent = 0;
  for (const [x, y] of shape.hull) {
    maxExtent = Math.max(maxExtent, Math.abs(x) * scale, Math.abs(y) * scale);
  }
  const half = maxExtent > 0 ? maxExtent * 1.1 : viewBoxHalf;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-${half} -${half} ${half * 2} ${half * 2}`}
      aria-hidden="true"
    >
      {shape.parts.map((part, i) => {
        const pts = part.points
          .map(([px, py]) => `${(px + part.offsetX) * scale},${-(py + part.offsetY) * scale}`)
          .join(' ');
        return (
          <polygon
            key={i}
            points={pts}
            fill={hex(part.color)}
            {...(part.stroke != null
              ? { stroke: hex(part.stroke), strokeWidth: part.strokeWidth ?? 1 }
              : {})}
          />
        );
      })}
    </svg>
  );
}
