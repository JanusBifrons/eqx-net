/**
 * Named beam-pool styles (WS-4 Phase 4 follow-up). Hoisted out of
 * `PixiRenderer.init` so the deliberate visual DISTINCTION between the combat
 * laser beam and the Miner's drill beam is a greppable, unit-lockable contract
 * — not two inline literals a copy-paste could quietly equalise (which would
 * make the mining beam indistinguishable from a combat laser, defeating the
 * dedicated-pool point).
 *
 * Type-only import of `BeamSpriteStyle` keeps this module free of any Pixi
 * runtime dependency, so the lock test (`beamStyles.test.ts`) needs no renderer.
 */
import type { BeamSpriteStyle } from './BeamSpritePool.js';

/** Remote players' / drones' / turrets' combat hitscan beam — thin warm amber. */
export const REMOTE_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffaa44, width: 2, alpha: 1 };

/** The Miner's mining (drill) beam — deliberately DISTINCT from the combat
 *  beam: a fatter, warmer amber at lower alpha so a player reads "mining laser",
 *  not "someone is shooting". */
export const MINING_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffb24d, width: 3.5, alpha: 0.9 };
