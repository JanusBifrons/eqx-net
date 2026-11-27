/**
 * Placement telemetry (owner playtest 2026-11-27: "Off your deck" nearly
 * everywhere, and no capture to say why). Each new ghost spot or verdict logs
 * one `build_ghost` line with the deck facts the `off-deck` rule reads; a
 * parked ghost logs nothing more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { plateCentreWorldInto } from '../../core/hex/plates.js';

const logged: Array<{ tag: string; data: Record<string, unknown> }> = [];
vi.mock('../debug/ClientLogger.js', () => ({
  logEvent: (tag: string, data: Record<string, unknown>) => { logged.push({ tag, data }); },
}));

const { notePlacementGhost, resetPlacementTelemetry } = await import('./placementTelemetry.js');

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

function mirror(): RenderMirror {
  return { swarm: new Map(), structures: new Map(), localPlayerId: 'me' } as unknown as RenderMirror;
}
function preview(plates: number[], kind = 'connector'): Preview {
  return { kind, x: 0, y: 0, angle: 0, deck: true, deckOwner: 'me', deckPlates: plates };
}

describe('build_ghost telemetry', () => {
  beforeEach(() => { logged.length = 0; resetPlacementTelemetry(); });

  it('logs each new spot once, with the deck facts behind the verdict', () => {
    const m = mirror();
    const pv = preview([0, 0], 'solar');
    const far = plateCentreWorldInto(5, 0, { x: 0, y: 0 });
    notePlacementGhost(pv, 0, 0, false, null, m);
    notePlacementGhost(pv, 0, 0, false, null, m); // parked: nothing new
    notePlacementGhost(pv, far.x, far.y, false, 'off-deck', m);
    expect(logged.map((l) => l.tag)).toEqual(['build_ghost', 'build_ghost']);
    const [a, b] = logged.map((l) => l.data);
    const t0 = a!.taps as number;
    expect(a).toMatchObject({ kind: 'solar', deckOwner: 'me', localPlayerId: 'me', plates: 1, onOwnPlate: true, plateCentre: [0, 0], rejection: null, mainVerdict: null });
    // A building far off the one plate: the worker said off-deck and the
    // main-thread re-check of the same core rule agrees.
    expect(b).toMatchObject({ onOwnPlate: false, plateCentre: [5, 0], rejection: 'off-deck', mainVerdict: 'off-deck', taps: t0 + 1 });
  });

  it('a verdict change on the same spot logs without counting a tap', () => {
    const m = mirror();
    const pv = preview([0, 0]);
    notePlacementGhost(pv, 0, 0, false, null, m);
    notePlacementGhost(pv, 0, 0, false, 'overlap-obstacle', m);
    expect(logged).toHaveLength(2);
    expect(logged[1]!.data).toMatchObject({ taps: logged[0]!.data.taps, rejection: 'overlap-obstacle' });
  });
});
