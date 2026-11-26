/** The loading screen's "Baking ship textures" step (split out of store.ts /
 *  storeTypes.ts, file caps). Discrete UI state, purity-clean: a whole-number
 *  percentage and a done flag, written only when they change and only while
 *  the join waits on art (`syncArtBake`), never per frame. */

export interface ArtBakeUi {
  /** Share of the on-screen Machined art baked, 0..100. Monotone within a join
   *  (more hulls coming into view never moves it backwards). */
  artBakePct: number;
  /** Every on-screen art handle is ready or failed (`RendererFeedback.artReady`). */
  artBakeReady: boolean;
  setArtBake: (pct: number, ready: boolean) => void;
}

/** The "nothing baked yet" defaults every new join re-arms to. */
export const ART_BAKE_REARM = { artBakePct: 0, artBakeReady: false } as const satisfies Partial<ArtBakeUi>;

/** The slice's initial state and setter, spread into the store. */
export function artBakeSlice(
  set: (partial: Partial<ArtBakeUi>) => void,
  get: () => ArtBakeUi,
): ArtBakeUi {
  return {
    ...ART_BAKE_REARM,
    setArtBake: (pct, ready) => {
      const s = get();
      const next = ready ? 100 : Math.max(s.artBakePct, Math.min(99, Math.floor(pct)));
      if (next === s.artBakePct && ready === s.artBakeReady) return;
      set({ artBakePct: next, artBakeReady: ready });
    },
  };
}

/** Renderer feedback → the slice: the share of on-screen art handles no
 *  longer pending. No art service (`total === 0` and ready) reads as done. */
export function syncArtBake(
  ui: Pick<ArtBakeUi, 'setArtBake'>,
  fb: { artReady: boolean; artBakeDone: number; artBakeTotal: number },
): void {
  ui.setArtBake(fb.artBakeTotal > 0 ? (fb.artBakeDone / fb.artBakeTotal) * 100 : 0, fb.artReady);
}
