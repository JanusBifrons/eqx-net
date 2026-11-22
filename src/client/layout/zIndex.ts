/**
 * Named z-index tiers for every painted layer in the client.
 *
 * Replaces the scattered numeric literals (10/15/20/90/100/200/1300+) that
 * used to live on each overlay. Anchor hosts in `LayoutProvider` set their
 * z-index from this table once; widgets do not set their own.
 *
 * Tier ordering (lowest → highest):
 *   canvas  < hud < mobileControls < hudOverSticks < railStrip < drawer < appBar < overlay
 *   < modal < prompt < transit
 *   < rotatePrompt (above the galaxy map chrome at 2000, below the
 *   lost-connection and error overlays at 9999)
 *
 * `hudOverSticks`: the bottom-centre HUD stack, above the thumb-stick touch
 * zones (14/15) so the status capsule's shield ring takes its tap on a phone in
 * landscape (where the capsule overlaps the move-stick zone). Its hosts and
 * widgets are `pointerEvents: 'none'` except the controls that take input.
 *
 * `railStrip`: the right rail and the left strip (UI language plan B2), over
 * the HUD and thumb-stick zones, under the panel (`drawer`) they open.
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
  railStrip: 1100,
  drawer: 1200,
  appBar: 1300,
  overlay: 1400,
  modal: 1450,
  prompt: 1475,
  transit: 1500,
  rotatePrompt: 5000,
} as const;

export type ZTier = keyof typeof Z;
