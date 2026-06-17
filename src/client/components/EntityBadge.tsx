import { ENTITY_VISUALS, ENTITY_BADGE_KNOCKOUT_CSS, entityBadgePolygon, type EntityKind } from '../render/entityVisuals';

/**
 * The shared entity badge, as SVG — a solid-colour SHAPE (per the entity VISUAL
 * LANGUAGE in render/entityVisuals.ts) with a count knocked OUT of it (cutout).
 * These are the SAME shapes/colours the Pixi galaxy map draws, so the icon
 * vocabulary is identical across the map, the drawer, and any future surface.
 * Pure presentational; the count is centred on the shape's optical centre.
 */
export function EntityBadge({
  kind,
  count,
  size = 18,
}: {
  kind: EntityKind;
  count: number;
  size?: number;
}): JSX.Element {
  const v = ENTITY_VISUALS[kind];
  const r = size / 2 - 0.5; // small inset so the shape doesn't clip the viewBox edge
  const pts = entityBadgePolygon(v.shape, r);
  let points = '';
  for (let i = 0; i < pts.length; i += 2) points += `${pts[i]},${pts[i + 1]} `;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ display: 'block', flex: '0 0 auto' }}
      aria-hidden
    >
      <polygon points={points.trim()} fill={v.cssColor} />
      <text
        x={0}
        y={v.numCenterYFrac * r}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.46}
        fontWeight={700}
        fontFamily="sans-serif"
        fill={ENTITY_BADGE_KNOCKOUT_CSS}
      >
        {count}
      </text>
    </svg>
  );
}
