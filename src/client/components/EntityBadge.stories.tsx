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

/** Centring check: every shape across 1- and 2-digit counts. */
export const Counts: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: 14, justifyItems: 'center' }}>
      {[1, 8, 12, 20].flatMap((c) =>
        ENTITY_KIND_ORDER.map((kind) => <EntityBadge key={`${kind}-${c}`} kind={kind} count={c} size={args.size} />),
      )}
    </div>
  ),
};
