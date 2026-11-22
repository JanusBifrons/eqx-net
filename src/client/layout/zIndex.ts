/**
 * Named z-index tiers for every painted layer in the client.
 *
 * Replaces the scattered numeric literals (10/15/20/90/100/200/1300+) that
 * used to live on each overlay. Anchor hosts in `LayoutProvider` set their
 * z-index from this table once; widgets do not set their own.
 *
 * Tier ordering (lowest → highest):
 *   canvas  < hud < mobileControls < hudOverSticks < panel < railStrip < overStrip < drawer < appBar < overlay
 *   < modal < prompt < transit
 *   < rotatePrompt (above the galaxy map chrome at 2000, below the
 *   lost-connection and error overlays at 9999)
 *
 * `hudOverSticks`: the bottom-centre HUD stack, above the thumb-stick touch
 * zones (14/15) so the status capsule's shield ring takes its tap on a phone in
 * landscape (where the capsule overlaps the move-stick zone). Its hosts and
 * widgets are `pointerEvents: 'none'` except the controls that take input.
 *
 * `panel`: the docked right panel (EqxPanel, plan A4), over the HUD and
 * thumb-stick zones, UNDER the rail (mock: .panel z 4, .rail z 5), so its
 * open and close slide passes beneath the rail.
 *
 * `railStrip`: the right rail and the left strip (UI language plan B2), over
 * the HUD, the thumb-stick zones and the panel they open; under the old
 * modal drawer (`drawer`).
 *
 * `overStrip`: HUD that must draw over the left strip and right rail without
 * touching them (the warp spool bar, owner 2026-11-22: it drew under the
 * strip); under `drawer`.
 *
 * `prompt`: the top-centre answer-me prompt (plan B2), above Windows
 * (`modal`) so it is never hidden, below the drag ghost (`transit`).
 *
 * `modal`: a game Dialog opened from an overlay (the loot window over the
 * world inspector); the drag ghost (`transit`) still draws above it.
 */
export const Z = {
  canvas: 0,
  hud: 10,
  mobileControls: 15,
  hudOverSticks: 16,
  panel: 1050,
  railStrip: 1100,
  overStrip: 1150,
  drawer: 1200,
  appBar: 1300,
  overlay: 1400,
  modal: 1450,
  prompt: 1475,
  transit: 1500,
  rotatePrompt: 5000,
} as const;

export type ZTier = keyof typeof Z;
