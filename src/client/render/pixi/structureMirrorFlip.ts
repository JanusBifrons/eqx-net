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
 * - the gun cluster: mount aim is a world bearing (#12), so the barrels keep
 *   their true aim angle; the server DOES mirror mount positions, so each
 *   gun's offset is negated inside the counter-flipped cluster.
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
  if (mountCluster === null) return;
  signScaleX(mountCluster, sign);
  // The server puts a mirrored mount at its flipped local point
  // (`structureLocalToWorld`), so the counter-flipped cluster negates each
  // gun's x offset (rotations untouched: the barrels keep the true aim).
  // Mount offsets are static after the cluster is built, so this runs only
  // when the mirror state changes; a rebuilt cluster starts unflipped.
  const want = sign < 0;
  if (offsetsFlipped.has(mountCluster) === want) return;
  const kids = mountCluster.children;
  for (let i = 0; i < kids.length; i++) kids[i]!.x = -kids[i]!.x;
  if (want) offsetsFlipped.add(mountCluster);
  else offsetsFlipped.delete(mountCluster);
}

/** Gun clusters whose mount offsets are currently negated. */
const offsetsFlipped = new WeakSet<Container>();

/**
 * Keep a text readout of a structure `sprite` upright and on its side of the
 * body ON SCREEN, whatever the structure's angle or mirror: a Shipyard placed
 * turned 90° otherwise drew its build countdown reading vertically along its
 * side. `baseY` is the readout's local y at angle 0 (negative = above the
 * body). Undoes the sprite's rotation (and its mirror) for the label alone.
 * Allocation-free (#14).
 */
export function uprightReadout(sprite: Container, t: Container, baseY: number): void {
  const sign = sprite.scale.x < 0 ? -1 : 1;
  const th = sprite.rotation;
  const rot = th === 0 ? 0 : -sign * th;
  if (t.rotation !== rot) t.rotation = rot;
  const x = sign * baseY * Math.sin(th);
  const y = baseY * Math.cos(th);
  if (t.x !== x || t.y !== y) t.position.set(x, y);
}
