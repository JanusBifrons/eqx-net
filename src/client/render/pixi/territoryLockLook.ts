/**
 * The Territory Lock's look (sector control): the SPIRE. A long broadcast
 * array: a spine the full width, a lantern tower in the middle, and three
 * pairs of antenna fins either side. The silhouette is a comb / mast: "this
 * sector is claimed, on every channel". Client-only: the footprint (400×300,
 * the collider) comes from the structure kind.
 *
 * Drawn with the structure plan's own vocabulary (rect + light ops), so the
 * classic sprite and the Machined forge both draw it. The lit lamps are the
 * lock's working parts (it is broadcasting the claim), so they go dark with
 * the rest of the base when unpowered.
 */

/** The plan helpers `structureVisuals.ts` lends the drawer. */
export interface LockKit {
  box(x: number, y: number, w: number, h: number, color: number, alpha?: number): void;
  slab(x: number, y: number, w: number, h: number, base: number, rim?: number): void;
  lit(x: number, y: number, r: number, color: number): void;
  mix(c: number, target: number, t: number): number;
}

export interface LockPalette { steel: number; dark: number; light: number; deck: number; red: number }

/** Draw the Territory Lock over the W×H footprint centred on 0,0. */
export function drawTerritoryLock(k: LockKit, W: number, H: number, accent: number, live: boolean, p: LockPalette): void {
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
