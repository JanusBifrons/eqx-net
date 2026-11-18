/**
 * DirectorActivity — one piece of periodic world work the `LivingWorldDirector`
 * runs on its control tick (~1.5 s, never the 60 Hz loop). A new world activity
 * is a new file under `director/` implementing this, plus one entry in the
 * director's `activities` list (built once in its constructor). Activities run
 * in list order, after wave planning and before the incoming-banner reconcile.
 */
export interface DirectorActivity {
  /** One control-tick step at game time `nowMs` (ms). */
  tick(nowMs: number): void;
}
