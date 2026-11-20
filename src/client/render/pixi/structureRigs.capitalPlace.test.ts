/**
 * A placed Capital appears like every other building (owner, sunday base
 * loop): the normal build fade, no crate panels, no unfold clip. Its rig
 * groups follow the body sprite's build-progress alpha.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { StructureRigs } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { rigClipIndex } from '../../../core/articulation/rig.js';

describe('a placed Capital', () => {
  it('has no unfold panels and no unfold clip on its rig', () => {
    const rig = rigForStructureKind('capital')!;
    expect(rig).not.toBeNull();
    expect(rig.partIds.some((id) => id.startsWith('unfold-'))).toBe(false);
    expect(rigClipIndex(rig, 'unfold')).toBe(-1);
  });

  it('its rig follows the body build fade, whatever clip the row carries', () => {
    const rigs = new StructureRigs(new Container());
    const sprite = new Container();
    // Not yet built: the body sprite is at the build-progress alpha.
    sprite.alpha = 0.45;
    for (let tick = 0; tick <= 300; tick += 60) {
      rigs.begin();
      const view = rigs.update('swarm-1', 'capital', sprite, 0, 0, 0, { clipId: 'unfold', startTick: 0 }, tick)!;
      expect(view.over.alpha).toBe(0.45);
      expect(view.under.alpha).toBe(0.45);
      for (const c of view.over.children) expect(c.label.startsWith('rig-part-unfold-')).toBe(false);
      rigs.sweep();
    }
  });
});
