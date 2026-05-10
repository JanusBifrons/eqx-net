/**
 * Named z-index tiers for every painted layer in the client.
 *
 * Replaces the scattered numeric literals (10/15/20/90/100/200/1300+) that
 * used to live on each overlay. Anchor hosts in `LayoutProvider` set their
 * z-index from this table once; widgets do not set their own.
 *
 * Tier ordering (lowest → highest):
 *   canvas  < hud < mobileControls < drawer < appBar < overlay < transit
 */
export const Z = {
  canvas: 0,
  hud: 10,
  mobileControls: 15,
  drawer: 1200,
  appBar: 1300,
  overlay: 1400,
  transit: 1500,
} as const;

export type ZTier = keyof typeof Z;
