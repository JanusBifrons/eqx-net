/**
 * Sub-capital break-up review (hostile review 2026-11-13, 30-v-30 fleet
 * fight): "the dead ship's name tag may stay on its wreck ('AI 062' sat on
 * the wreckage ~1 s)". Check: a dead NPC's label goes the frame it dies,
 * whatever the dying-hull hold does with its sprite (the hold keeps the
 * SPRITE, never the mirror entry the label reads), and wreck pieces (kind 4)
 * never get a label.
 *
 * Finding: this already holds. The tag in the review's crops (`crops6/a4`,
 * t 8.8 s) belongs to the LIVE robot just below the wreck: labels sit
 * `LABEL_OFFSET_DRONE` above their own sprite, so a neighbour's tag lands on
 * the debris; before the kill it was hidden behind the dead ship's damage
 * number and fireball. This test locks the real contract.
 *
 * Level: the destroy message handler + the label manager, the seam where a
 * stale label would live (the label reads `mirror.swarm`).
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { ColyseusGameClient } from './ColyseusClient.js';
import { LabelManager } from '../render/Labels.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

interface Internals {
  mirror: RenderMirror & { swarm: Map<number, unknown> };
  handleDestroy(evt: { type: 'destroy'; targetId: string; shooterId: string }): void;
}

function entry(kind: number, x: number): unknown {
  return { x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 24, kind, shipKind: 'robot-square', sleeping: false };
}

const labelCount = (m: LabelManager): number => (m as unknown as { labels: Map<string, unknown> }).labels.size;
const labelKeys = (m: LabelManager): string[] => [...(m as unknown as { labels: Map<string, unknown> }).labels.keys()];

describe('a dead NPC loses its name tag the frame it dies', () => {
  it('destroy → the next label update has no tag for it; wreck pieces never get one', () => {
    const client = new ColyseusGameClient();
    const internals = client as unknown as Internals;
    internals.mirror.swarm = new Map([[0x62, entry(1, 0)], [0x72, entry(1, 60)]]);
    const labels = new LabelManager(new Container());
    labels.update(internals.mirror);
    expect(labelCount(labels)).toBe(2);

    internals.handleDestroy({ type: 'destroy', targetId: 'swarm-98', shooterId: 'x' });
    // Its wreck pieces arrive (kind 4, new entity ids) where it died.
    internals.mirror.swarm.set(0x80, entry(4, 0));
    internals.mirror.swarm.set(0x81, entry(4, 2));
    labels.update(internals.mirror);
    expect(labelKeys(labels)).toEqual([`d:${0x72}`]);
    labels.destroy();
  });
});
