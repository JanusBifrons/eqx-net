/**
 * Mining-barge look options (plan partitioned-chasing-lark, PR 14). Locks:
 *  - each look A/B/C is a valid capital ship-kind record (schema);
 *  - the brief: ~1.3× a battleship's length, broad (≥ 1.9× its beam), mining
 *    lasers AND tractor placeholders in every size S/M/L/XL down both sides,
 *    oversized stern engines, no naval guns, no allegiance, never in a random
 *    spawn pool, and a cargo hold;
 *  - the dev switch: unset, the catalogue is unchanged (no `barge-look`).
 */
import { describe, expect, it } from 'vitest';
import { defineCapitalShipKind } from '../../shipScale/defineShipKind.js';
import { getShipKind, isShipKindId, SHIP_KINDS, SHIP_KINDS_LIST } from '../../shipKinds.js';
import { BARGE_LOOKS, BARGE_LOOK_KIND_ID, TRACTOR_PLACEHOLDER_WEAPON, bargeDesign } from './bargeDesign.js';
import { BARGE_LOOK, resolveBargeLook } from './bargeLookConfig.js';
import { inRandomSpawnPool } from '../../shipKinds.js';

const battleship = getShipKind('battleship');
const bsBeam = 2 * Math.max(...(battleship.shape as { hull: Array<[number, number]> }).hull.map(([x]) => Math.abs(x)));
const bsLength = battleship.radius * 2;

describe.each(BARGE_LOOKS)('barge look %s', (look) => {
  const d = bargeDesign(look);
  const kind = defineCapitalShipKind(d.record);

  it('validates as a capital ship kind', () => {
    expect(kind.id).toBe(BARGE_LOOK_KIND_ID);
    expect(kind.sizeClass).toBe('capital');
    expect(kind.npcOnly).toBe(true);
    expect(inRandomSpawnPool(kind)).toBe(false);
    expect('allegiance' in kind).toBe(false);
  });

  it('is a container ship: about 1.3× a battleship long, broad, with a hold', () => {
    expect(d.length / bsLength).toBeGreaterThan(1.25);
    expect(d.length / bsLength).toBeLessThan(1.35);
    expect(d.beam / bsBeam).toBeGreaterThan(1.9);
    expect(d.holdArea).toBeGreaterThan(0.18 * d.length * d.beam);
    expect(kind.cargoCapacity).toBeGreaterThan(0);
    // The collider spans the drawn beam.
    const hull = (kind.shape as { hull: Array<[number, number]> }).hull;
    expect(2 * Math.max(...hull.map(([x]) => Math.abs(x)))).toBeCloseTo(d.beam, 0);
  });

  it('is lined with mining lasers and tractors of varying sizes, down both sides', () => {
    const m = kind.mounts ?? [];
    expect(m.every((x) => [String('mining_laser'), TRACTOR_PLACEHOLDER_WEAPON].includes(x.weaponId))).toBe(true);
    const sizes = new Set(m.map((x) => x.size));
    for (const s of ['S', 'M', 'L', 'XL']) expect(sizes.has(s as 'S')).toBe(true);
    expect(m.some((x) => x.id.startsWith('tractor-'))).toBe(true);
    expect(m.filter((x) => x.localX > 0).length).toBe(m.filter((x) => x.localX < 0).length);
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);
    expect(d.lasers.S + d.lasers.M + d.lasers.L + d.lasers.XL + d.tractors.S + d.tractors.M + d.tractors.L + d.tractors.XL).toBe(m.length);
    // Every mount is in exactly one weapon group.
    const grouped = (kind.slots ?? []).flatMap((s) => s.mountIds);
    expect(grouped.sort()).toEqual(m.map((x) => x.id).sort());
  });

  it('has gigantic stern engines (nozzles ≥ 3× a battleship\'s)', () => {
    expect(kind.thrusters!.size).toBeGreaterThan(3 * battleship.thrusters!.size);
    expect(kind.thrusters!.count).toBeGreaterThanOrEqual(4);
  });
});

describe('barge look switch', () => {
  it('reads env, page global and worker name', () => {
    expect(resolveBargeLook({ env: { EQX_BARGE_LOOK: 'B' } })).toBe('B');
    expect(resolveBargeLook({ global: { __EQX_BARGE_LOOK__: 'C' } })).toBe('C');
    expect(resolveBargeLook({ workerName: 'shipScale=1;bargeLook=A' })).toBe('A');
    expect(resolveBargeLook({ env: { EQX_BARGE_LOOK: 'Z' } })).toBeNull();
    expect(resolveBargeLook({})).toBeNull();
  });

  it.runIf(BARGE_LOOK === null)('unset: the catalogue has no barge-look kind', () => {
    expect(isShipKindId(BARGE_LOOK_KIND_ID)).toBe(false);
    expect(SHIP_KINDS_LIST.at(-1)!.id).toBe('battlecruiser-lance');
    expect(Object.keys(SHIP_KINDS)).toEqual(SHIP_KINDS_LIST.map((k) => k.id));
  });
});
