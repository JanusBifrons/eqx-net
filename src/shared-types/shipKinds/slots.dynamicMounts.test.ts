/**
 * Dynamic weapon mounts (latent slots) — pure resolver lock (Phase 4 WS-B3,
 * plan: effervescent-umbrella, invariant #13 "the behaviour lives at the pure
 * geometry-lookup seam").
 *
 * Activated latent mounts ride the player ShipState/roster as a list of
 * `{ slotId, weaponId }`; the GEOMETRY for an activated slot is looked up from
 * the ship-kind catalogue's `latentMounts` by `slotId` (no geometry on the
 * wire — the same trick as scrap colliders). These pure resolvers are the ONE
 * place that mapping lives:
 *
 *   - `resolveActivatedMounts(kind, activated)` — the activated latent
 *     hardpoints as full `WeaponMount`s (catalogue geometry, the player's
 *     chosen `weaponId` overriding the latent default).
 *   - `resolveInstanceMounts(kind, activated)` — `[...kind.mounts, ...activated]`
 *     (the per-instance angle index space + render list — base mounts keep
 *     their catalogue indices, activated latent mounts append).
 *   - `resolveInstanceFireMounts(kind, activated, slotId)` —
 *     `[...resolveSlotMounts(kind, slotId), ...activated]` (the FIRING set: the
 *     active slot's base mounts + every activated latent mount).
 *
 * Locks the WS-B3 spec assertions:
 *  - an activated slot resolves to its catalogue geometry (position + arc);
 *  - a non-activated latent slot does NOT appear (it does not fire);
 *  - the chosen weapon overrides the latent default;
 *  - an unknown / duplicate slotId is ignored (defensive — a malformed roster
 *    row can't crash the fire path);
 *  - un-upgraded ships are BYTE-IDENTICAL to pre-WS-B3 (empty activated list ⇒
 *    the base mount list, same references).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveActivatedMounts,
  resolveInstanceMounts,
  resolveInstanceFireMounts,
  resolveSlotMounts,
} from './slots.js';
import { FIGHTER } from './fighters.js';
import { GUNSHIP } from './heavyClass.js';
import type { ActivatedMountSpec } from './slots.js';

describe('dynamic weapon mounts — pure resolvers (WS-B3)', () => {
  it('FIGHTER declares at least one latent mount slot (catalogue fixture)', () => {
    expect(FIGHTER.latentMounts).toBeDefined();
    expect(FIGHTER.latentMounts!.length).toBeGreaterThan(0);
    // Latent ids must be distinct from the base mount ids (so the per-instance
    // index space never collides).
    const baseIds = new Set((FIGHTER.mounts ?? []).map((m) => m.id));
    for (const lm of FIGHTER.latentMounts!) {
      expect(baseIds.has(lm.id)).toBe(false);
    }
  });

  it('resolveActivatedMounts: an activated slot resolves to its catalogue geometry, weapon overridden', () => {
    const latent = FIGHTER.latentMounts![0]!;
    const activated: ActivatedMountSpec[] = [{ slotId: latent.id, weaponId: 'heat-seeker' }];
    const out = resolveActivatedMounts(FIGHTER, activated);
    expect(out).toHaveLength(1);
    // Geometry is the catalogue's — position + arc + rotation match.
    expect(out[0]!.id).toBe(latent.id);
    expect(out[0]!.localX).toBe(latent.localX);
    expect(out[0]!.localY).toBe(latent.localY);
    expect(out[0]!.baseAngle).toBe(latent.baseAngle);
    expect(out[0]!.arcMin).toBe(latent.arcMin);
    expect(out[0]!.arcMax).toBe(latent.arcMax);
    // The player's chosen weapon overrides the latent default.
    expect(out[0]!.weaponId).toBe('heat-seeker');
  });

  it('resolveActivatedMounts: a non-activated latent slot does NOT appear', () => {
    // Empty activation → no activated mounts at all (the non-activated slot
    // does not fire / render).
    expect(resolveActivatedMounts(FIGHTER, [])).toHaveLength(0);
  });

  it('resolveActivatedMounts: an unknown slotId is ignored (defensive)', () => {
    const out = resolveActivatedMounts(FIGHTER, [{ slotId: 'no-such-slot', weaponId: 'laser' }]);
    expect(out).toHaveLength(0);
  });

  it('resolveActivatedMounts: a duplicate slotId is collapsed to one', () => {
    const latent = FIGHTER.latentMounts![0]!;
    const out = resolveActivatedMounts(FIGHTER, [
      { slotId: latent.id, weaponId: 'laser' },
      { slotId: latent.id, weaponId: 'hitscan' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('resolveInstanceMounts: base mounts keep catalogue indices, activated append', () => {
    const latent = FIGHTER.latentMounts![0]!;
    const base = FIGHTER.mounts!;
    const out = resolveInstanceMounts(FIGHTER, [{ slotId: latent.id, weaponId: 'laser' }]);
    expect(out).toHaveLength(base.length + 1);
    // Base mounts are first, same id order as the catalogue.
    for (let i = 0; i < base.length; i++) expect(out[i]!.id).toBe(base[i]!.id);
    // Activated latent appended.
    expect(out[base.length]!.id).toBe(latent.id);
  });

  it('resolveInstanceMounts: un-upgraded ⇒ the base mount list (byte-identical)', () => {
    const out = resolveInstanceMounts(FIGHTER, []);
    const base = FIGHTER.mounts!;
    expect(out).toHaveLength(base.length);
    for (let i = 0; i < base.length; i++) expect(out[i]).toBe(base[i]);
  });

  it('resolveInstanceFireMounts: the active slot mounts + every activated latent mount fire', () => {
    const latent = FIGHTER.latentMounts![0]!;
    const slotMounts = resolveSlotMounts(FIGHTER);
    const out = resolveInstanceFireMounts(FIGHTER, [{ slotId: latent.id, weaponId: 'laser' }]);
    expect(out).toHaveLength(slotMounts.length + 1);
    for (let i = 0; i < slotMounts.length; i++) expect(out[i]!.id).toBe(slotMounts[i]!.id);
    expect(out[slotMounts.length]!.id).toBe(latent.id);
  });

  it('resolveInstanceFireMounts: un-upgraded ⇒ exactly the active slot mounts (no behaviour change)', () => {
    const out = resolveInstanceFireMounts(GUNSHIP, []);
    const slotMounts = resolveSlotMounts(GUNSHIP);
    expect(out).toHaveLength(slotMounts.length);
    for (let i = 0; i < slotMounts.length; i++) expect(out[i]).toBe(slotMounts[i]);
  });

  it('resolveActivatedMounts: a kind with no latentMounts yields nothing', () => {
    // GUNSHIP (no latent slots authored) → activation is a no-op.
    expect(resolveActivatedMounts(GUNSHIP, [{ slotId: 'whatever', weaponId: 'laser' }])).toHaveLength(0);
  });
});
