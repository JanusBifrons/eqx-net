import type { Meta, StoryObj } from '@storybook/react';
import { EntityBadge } from './EntityBadge';
import { ENTITY_KIND_ORDER, entityLabel } from '../render/entityVisuals';

/**
 * The shared entity badge — the game's icon VISUAL LANGUAGE. The same shapes +
 * colours render on the Pixi galaxy map and in the React drawer; this is where to
 * iterate on shape geometry, colour, and number-centring in isolation.
 */
const meta: Meta<typeof EntityBadge> = {
  title: 'Visual language/EntityBadge',
  component: EntityBadge,
  args: { kind: 'hostile', count: 8, size: 64 },
  argTypes: {
    kind: { control: 'select', options: ENTITY_KIND_ORDER },
    count: { control: { type: 'number', min: 0, max: 99 } },
    size: { control: { type: 'range', min: 12, max: 240, step: 2 } },
  },
};
export default meta;
type Story = StoryObj<typeof EntityBadge>;

export const Playground: Story = {};

/** All four entity types side by side with their labels — the full vocabulary. */
export const AllKinds: Story = {
  render: (args) => (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
      {ENTITY_KIND_ORDER.map((kind) => (
        <div key={kind} style={{ textAlign: 'center', color: '#cfe', font: '13px sans-serif' }}>
          <EntityBadge kind={kind} count={args.count} size={args.size} />
          <div style={{ marginTop: 8 }}>{entityLabel(kind, args.count)}</div>
        </div>
      ))}
    </div>
  ),
};

/**
 * Centring check across the full digit range — every shape down a row, every count
 * across the columns: 1-9 (single digit), double digits, and overflow above 99.
 * Scan each row to confirm the knockout number reads centred at every width.
 */
const COUNT_SAMPLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20, 88, 100, 999];
export const Counts: Story = {
  render: (args) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `auto repeat(${COUNT_SAMPLES.length}, auto)`,
        gap: 12,
        alignItems: 'center',
        justifyItems: 'center',
      }}
    >
      {/* header row: blank corner + the count values */}
      <div />
      {COUNT_SAMPLES.map((c) => (
        <div key={`h-${c}`} style={{ color: '#7f93a8', font: '11px sans-serif' }}>
          {c}
        </div>
      ))}
      {/* one row per kind */}
      {ENTITY_KIND_ORDER.map((kind) => (
        <Row key={kind} kind={kind} size={args.size} />
      ))}
    </div>
  ),
};

function Row({ kind, size }: { kind: (typeof ENTITY_KIND_ORDER)[number]; size?: number }): JSX.Element {
  return (
    <>
      <div style={{ color: '#cfe', font: '12px sans-serif', justifySelf: 'end', paddingRight: 8 }}>{kind}</div>
      {COUNT_SAMPLES.map((c) => (
        <EntityBadge key={`${kind}-${c}`} kind={kind} count={c} size={size} />
      ))}
    </>
  );
}
