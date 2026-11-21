/**
 * Build mirror drawing (base loop 4C). A structure placed mirrored draws
 * left-right flipped in its LOCAL frame: the sprite's x scale goes negative,
 * and Pixi applies scale before rotation, which is exactly the shared
 * `structureLocalToWorld` (flip local x, then rotate). Everything hung off the
 * sprite (body art, build-up hologram, rig plane group, socket nubs) flips
 * with it; the rig's over/under groups copy the sign in `followHost`.
 *
 * Two things must NOT read mirrored, so they are counter-flipped:
 * - the world readouts (text labels): mirrored text is unreadable;
 * - the gun cluster: mount aim is a world bearing (#12) and the server does
 *   not mirror mounts, so the guns keep their true aim and offset.
 *
 * Allocation-free (#14): sign writes only, a module-constant label list.
 */
import type { Container } from 'pixi.js';

/** The structure sprite's text readouts (labels set in `spriteBuilders.ts`
 *  and `buildEtaLabel.ts`). */
const READOUT_LABELS: readonly string[] = ['capitalResource', 'buildEta', 'batteryCharge'];

/** Give `c`'s x scale the sign `sign` (keeps its size). */
function signScaleX(c: Container, sign: number): void {
  const v = sign * Math.abs(c.scale.x);
  if (c.scale.x !== v) c.scale.x = v;
}

/**
 * Flip the structure `sprite` for `mirror`. Returns true when the sprite is
 * or was mirrored (the caller then runs {@link counterFlipStructureParts}
 * once its readouts and mounts are posed this frame); false = the common
 * unmirrored case, nothing more to do.
 */
export function applyStructureMirror(sprite: Container, mirror: boolean): boolean {
  const was = sprite.scale.x < 0;
  signScaleX(sprite, mirror ? -1 : 1);
  return mirror || was;
}

/** Counter-flip the readouts and the gun cluster of a structure sprite so
 *  they draw unmirrored on screen (both flips cancel). Call after anything
 *  that rewrites their scale this frame (`fitBuildEtaLabel`, `placeMount`). */
export function counterFlipStructureParts(sprite: Container, mountCluster: Container | null): void {
  const sign = sprite.scale.x < 0 ? -1 : 1;
  for (let i = 0; i < READOUT_LABELS.length; i++) {
    const t = sprite.getChildByLabel(READOUT_LABELS[i]!);
    if (t !== null) signScaleX(t, sign);
  }
  if (mountCluster !== null) signScaleX(mountCluster, sign);
}
