/**
 * Hand-authored structure layouts for test / scenario rooms (plan
 * soft-leaping-truffle v2, phase V). ONE source shared by the room
 * definitions in `src/server/index.ts` and the integration tests, so the
 * footprint-correct geometry is derived once.
 *
 * Footprints (catalogue v9): Capital 560×560, Connector 64×64, Solar 360×150,
 * Miner 240×240, Turret 140×140. Rules every layout here satisfies: no
 * overlapping boxes, every link ≤ 600 u edge-to-edge with clear line of
 * sight, the Capital links only to Connectors (max 4).
 *
 * The standard powered grid ("structure scenario"):
 *
 *           Solar NW (-250, 400)   Connector N (0, 350)   Solar NE (250, 400)
 *                                   Capital (0, 0)
 *           Miner SW (-200, -420)  Connector S (0, -350)  Turret SE (150, -400)
 *
 *   Capital 50 + 2 Solars 60 − Miner 60 − Turret 15 = +35 ⇒ powered.
 *   An asteroid sits in the Miner's range; a drone in the Turret's range.
 */

export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * Gates E2E / showcase base: a powered Capital with two Shield Gates south of
 * it, side by side. The WEST gate opens for anyone not hostile; the EAST gate
 * opens for its owner only — and the owner is `scenario`, so a visiting pilot
 * is locked out. Ships spawned south of a gate and flown north (+y) test both.
 * Power: Capital 50 + Solar 30 = 80 ≥ 2 gates × 30.
 */
export const GATE_TEST = {
  openGate: { x: -400, y: -900 },
  lockedGate: { x: 400, y: -900 },
} as const;

export const GATE_TEST_PREBUILT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: 0, y: 350 },
  { kind: 'solar', x: 250, y: 400 },
  { kind: 'connector', x: 0, y: -350 },
  { kind: 'shield_gate', ...GATE_TEST.openGate, gateAccess: 'open' },
  { kind: 'shield_gate', ...GATE_TEST.lockedGate, gateAccess: 'owner' },
] as const;

export const SCENARIO = {
  capital: { x: 0, y: 0 },
  connectorN: { x: 0, y: 350 },
  connectorS: { x: 0, y: -350 },
  solarNE: { x: 250, y: 400 },
  solarNW: { x: -250, y: 400 },
  minerSW: { x: -200, y: -420 },
  turretSE: { x: 150, y: -400 },
  /** In the Miner's 800 u range (≈ 573 u away). */
  asteroid: { x: -700, y: -700, radius: 30 },
  /** In the Turret's 600 u range (550 u below it). */
  drone: { x: 150, y: -950 },
} as const;

/** The full powered scenario grid, in an order auto-connect wires correctly
 *  (hubs before their leaves). */
export const STRUCTURE_SCENARIO_PREBUILT = [
  { kind: 'capital', ...SCENARIO.capital },
  { kind: 'connector', ...SCENARIO.connectorN },
  { kind: 'connector', ...SCENARIO.connectorS },
  { kind: 'solar', ...SCENARIO.solarNE },
  { kind: 'solar', ...SCENARIO.solarNW },
  { kind: 'miner', ...SCENARIO.minerSW },
  { kind: 'turret', ...SCENARIO.turretSE },
] as const;

/** A "ready base" for the wave system (Capital + Miner + Solar + Turret,
 *  wired through the two connectors) — the same grid. */
export const READY_BASE_PREBUILT = STRUCTURE_SCENARIO_PREBUILT;
