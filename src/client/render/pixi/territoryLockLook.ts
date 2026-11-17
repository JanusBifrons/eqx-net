/**
 * Territory Lock look R&D (sector control): three candidate looks for the
 * `territory_lock` structure, for the owner to pick from. Dev switch
 * `?lockLook=a|b|c` (default A). Read once at module load, like the barge-look
 * switch (`bargeLookConfig.ts`), so the page and every worker agree:
 *  - page: `globalThis.__EQX_LOCK_LOOK__`, set by `index.html` from `?lockLook=`;
 *  - workers: the worker `name` (`lockLook=b`, appended by `lockLookWorkerNameSuffix`).
 * Client-only: the look never changes the footprint (400×300, the collider).
 *
 * Each look is drawn with the structure plan's own vocabulary (rect + light
 * ops), so the classic sprite and the Machined forge both draw it. The lit
 * lamps are the lock's working parts (it is broadcasting the claim), so they
 * go dark with the rest of the base when unpowered.
 */
export type LockLook = 'a' | 'b' | 'c';
export const LOCK_LOOKS: readonly LockLook[] = ['a', 'b', 'c'];

interface Sources { global?: { __EQX_LOCK_LOOK__?: unknown }; workerName?: string }

export function resolveLockLook(src: Sources): LockLook {
  let v: unknown = src.global?.__EQX_LOCK_LOOK__;
  if (src.workerName) v ??= /lockLook=([abc])/.exec(src.workerName)?.[1];
  const s = typeof v === 'string' ? v.toLowerCase() : v;
  return s === 'b' || s === 'c' ? s : 'a';
}

const g = globalThis as unknown as { __EQX_LOCK_LOOK__?: unknown; name?: unknown; WorkerGlobalScope?: unknown };
export const LOCK_LOOK: LockLook = resolveLockLook({
  global: g,
  workerName: typeof g.WorkerGlobalScope !== 'undefined' && typeof g.name === 'string' ? g.name : undefined,
});

/** Appended to a worker's name so workers draw the same look (default adds nothing). */
export function lockLookWorkerNameSuffix(): string {
  return LOCK_LOOK === 'a' ? '' : `;lockLook=${LOCK_LOOK}`;
}

/** The plan helpers `structureVisuals.ts` lends the drawer. */
export interface LockKit {
  box(x: number, y: number, w: number, h: number, color: number, alpha?: number): void;
  slab(x: number, y: number, w: number, h: number, base: number, rim?: number): void;
  lit(x: number, y: number, r: number, color: number): void;
  mix(c: number, target: number, t: number): number;
}

export interface LockPalette { steel: number; dark: number; light: number; deck: number; red: number; hazard: number }

/** Draw the Territory Lock in `look` over the W×H footprint centred on 0,0. */
export function drawTerritoryLock(k: LockKit, look: LockLook, W: number, H: number, accent: number, live: boolean, p: LockPalette): void {
  if (look === 'b') drawSeal(k, H, accent, live, p);
  else if (look === 'c') drawSpire(k, W, H, accent, live, p);
  else drawAnchor(k, W, H, accent, live, p);
}

/** A: the ANCHOR. A heavy cross of girders pinned to the rock at four clamp
 *  feet (the flukes), a stepped tower in the middle topped by the beacon. The
 *  silhouette is a plus sign with fat ends: "this is nailed down". */
function drawAnchor(k: LockKit, W: number, H: number, accent: number, live: boolean, p: LockPalette): void {
  const x0 = -W / 2, y0 = -H / 2, arm = 46;
  // Girders: a long beam across, a shorter one down, each with a truss spine.
  k.slab(x0 + 30, -arm / 2, W - 60, arm, p.dark, 6);
  k.slab(-arm / 2, y0 + 30, arm, H - 60, p.dark, 6);
  for (let x = x0 + 44; x < -70; x += 22) k.box(x, -2, 12, 4, p.light, 0.9);
  for (let x = 70; x < -x0 - 54; x += 22) k.box(x, -2, 12, 4, p.light, 0.9);
  for (let y = y0 + 44; y < -70; y += 22) k.box(-2, y, 4, 12, p.light, 0.9);
  for (let y = 70; y < -y0 - 54; y += 22) k.box(-2, y, 4, 12, p.light, 0.9);
  // Clamp feet: wide plates across each arm's end, with bolt heads, hazard edge.
  const feet: Array<[number, number, number, number]> = [
    [x0, -62, 44, 124], [-x0 - 44, -62, 44, 124], [-70, y0, 140, 40], [-70, -y0 - 40, 140, 40],
  ];
  for (const [fx, fy, fw, fh] of feet) {
    k.slab(fx, fy, fw, fh, p.steel, 6);
    const along = fw < fh;
    for (let t = 14; t < (along ? fh : fw) - 10; t += 26) {
      k.box(along ? fx + fw / 2 - 5 : fx + t, along ? fy + t : fy + fh / 2 - 5, 10, 10, p.dark);
    }
  }
  // Tower: three stepped tiers, cut corners, beacon housing on top.
  k.slab(-72, -72, 144, 144, p.steel, 8);
  for (const [cx, cy] of [[-72, -72], [56, -72], [-72, 56], [56, 56]] as const) k.box(cx, cy, 16, 16, p.deck);
  k.slab(-50, -50, 100, 100, p.light, 6);
  k.box(-30, -30, 60, 60, p.dark);
  k.box(-22, -22, 44, 44, live ? accent : k.mix(accent, p.dark, 0.7), 0.95);
  k.lit(0, 0, 24, accent);
  for (const [lx, ly] of [[x0 + 22, 0], [-x0 - 22, 0], [0, y0 + 20], [0, -y0 - 20]] as const) k.lit(lx, ly, 7, p.red);
}

/** B: the SEAL. A round vault door laid flat: a thick bulkhead ring, eight
 *  locking bolts run in to a central hub, and the hub's lamp. Round and
 *  compact (the 400 width is left empty either side): "this is sealed shut". */
function drawSeal(k: LockKit, H: number, accent: number, live: boolean, p: LockPalette): void {
  const R = H / 2; // outer radius
  // Ring: stacked rows clipped to a circle make an octagon-ish disc.
  const step = 12;
  for (let y = -R; y < R; y += step) {
    const yc = y + step / 2;
    const half = Math.round(Math.sqrt(Math.max(0, R * R - yc * yc)) / 6) * 6;
    if (half > 0) k.box(-half, y, half * 2, step, k.mix(p.dark, 0x000000, 0.2));
  }
  const ring = R - 14;
  for (let y = -ring; y < ring; y += step) {
    const yc = y + step / 2;
    const half = Math.round(Math.sqrt(Math.max(0, ring * ring - yc * yc)) / 6) * 6;
    if (half > 0) k.box(-half, y, half * 2, step, p.steel);
  }
  const inner = R - 52;
  for (let y = -inner; y < inner; y += step) {
    const yc = y + step / 2;
    const half = Math.round(Math.sqrt(Math.max(0, inner * inner - yc * yc)) / 6) * 6;
    if (half > 0) k.box(-half, y, half * 2, step, p.deck);
  }
  // Ring segment seams (8 joints).
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4;
    const mx = Math.cos(a) * (R - 32), my = Math.sin(a) * (R - 32);
    k.box(mx - 4, my - 4, 8, 8, p.dark);
  }
  // Locking bolts: four straight (axis) and four stepped (diagonal), each a
  // bar from the ring to the hub with a lit bolt-head at the ring end.
  const hub = 46;
  k.slab(-hub - 10, -14, (hub + 10) * 2, 28, p.light, 4);
  k.slab(-14, -hub - 10, 28, (hub + 10) * 2, p.light, 4);
  k.box(-inner, -10, inner - hub, 20, p.light);
  k.box(hub, -10, inner - hub, 20, p.light);
  k.box(-10, -inner, 20, inner - hub, p.light);
  k.box(-10, hub, 20, inner - hub, p.light);
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
    for (let t = hub * 0.72; t < inner * 0.72; t += 9) k.box(sx * t - 7, sy * t - 7, 14, 14, p.light);
  }
  // Hub: the seal plate with a hazard cross-band, the lamp in the middle.
  k.slab(-hub, -hub, hub * 2, hub * 2, p.steel, 6);
  for (let x = -hub + 8; x < hub - 8; x += 16) k.box(x, -4, 8, 8, p.hazard, 0.9);
  k.box(-20, -20, 40, 40, p.dark);
  k.box(-14, -14, 28, 28, live ? accent : k.mix(accent, p.dark, 0.7), 0.95);
  k.lit(0, 0, 20, accent);
  for (const [bx, by] of [[-inner - 4, 0], [inner + 4, 0], [0, -inner - 4], [0, inner + 4]] as const) k.lit(bx, by, 6, accent);
}

/** C: the SPIRE. A long broadcast array: a spine the full width, a lantern
 *  tower in the middle, and a row of tall antenna fins either side. The
 *  silhouette is a comb / mast: "this sector is claimed, on every channel". */
function drawSpire(k: LockKit, W: number, H: number, accent: number, live: boolean, p: LockPalette): void {
  const x0 = -W / 2, y0 = -H / 2;
  // Spine with a truss along it.
  k.slab(x0, -24, W, 48, p.dark, 6);
  for (let x = x0 + 14; x < -x0 - 14; x += 20) k.box(x, -3, 10, 6, p.light, 0.9);
  // Fins: three pairs either side of the lantern, tapering toward the ends.
  const fins = [110, 150, 186];
  fins.forEach((fx, i) => {
    const len = H / 2 - 6 - i * 26;
    for (const sx of [-1, 1]) {
      const cx = sx * fx;
      k.slab(cx - 9, -len, 18, len * 2, p.steel, 4);
      k.box(cx - 2, -len + 10, 4, len * 2 - 20, p.dark);
      // Emitter caps at the fin tips (the broadcast heads).
      k.box(cx - 12, -len, 24, 12, p.light);
      k.box(cx - 12, len - 12, 24, 12, p.light);
      k.lit(cx, -len + 6, 5, accent);
      k.lit(cx, len - 6, 5, accent);
    }
  });
  // Lantern tower: cut-corner block, stepped, a tall lamp slot down its middle.
  k.slab(-64, y0 + 10, 128, H - 20, p.steel, 8);
  for (const [cx, cy] of [[-64, y0 + 10], [48, y0 + 10], [-64, -y0 - 26], [48, -y0 - 26]] as const) k.box(cx, cy, 16, 16, p.deck);
  k.slab(-42, y0 + 34, 84, H - 68, p.light, 6);
  k.box(-18, y0 + 50, 36, H - 100, p.dark);
  k.box(-12, y0 + 56, 24, H - 112, live ? accent : k.mix(accent, p.dark, 0.7), 0.95);
  k.lit(0, -40, 14, accent);
  k.lit(0, 40, 14, accent);
  k.lit(x0 + 10, 0, 6, p.red);
  k.lit(-x0 - 10, 0, 6, p.red);
}
