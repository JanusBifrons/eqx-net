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

/**
 * Articulation sandbox (structure-restyle 2f, plan §5): a small outpost, a
 * freight dock (its crane rig and loading pad, open side +y) and a turret
 * (its hatch + pop-up rig) beside it, both at rot 0 so host frame = world
 * offset. A scripted trader hauler flies onto the pad and the crane reaches
 * for it (`rigClip` scene steps; Stage 3 starts the crane from the deposit
 * dwell instead). Times are ms after the first pilot is ready; the scene
 * starts after `lead` so a take can be rolling first.
 */
export const RIG_SANDBOX = {
  dock: { x: 0, y: 0 },
  /** Pad centre (dock host frame (0, 460)). */
  pad: { x: 0, y: 460 },
  /** The pad's far west corner, the hauler's off-centre berth. */
  padCorner: { x: -380, y: 640 },
  turret: { x: 720, y: 0 },
  haulerEntry: { x: 0, y: 1700 },
} as const;

export const RIG_SANDBOX_PREBUILT = [
  { kind: 'freight_dock', ...RIG_SANDBOX.dock },
  { kind: 'turret', ...RIG_SANDBOX.turret },
] as const;

/** The filmed timeline (≈ 27 s after `lead`). */
export function rigSandboxScene(lead: number): unknown[] {
  const t = (s: number): number => Math.round(lead + s * 1000);
  const H = 'hauler';
  return [
    // 1. Fly in, stop on the pad; after ~1 s the crane reaches, holds, retracts; out.
    { atMs: t(0), action: 'spawn', tag: H, kind: 'trader-hauler', count: 1, ...RIG_SANDBOX.haulerEntry },
    { atMs: t(0), action: 'move', tag: H, ...RIG_SANDBOX.pad, speed: 320 },
    { atMs: t(5.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(6.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-hold', keepTarget: true },
    { atMs: t(8.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', keepTarget: true },
    { atMs: t(9.5), action: 'move', tag: H, x: -700, y: 1150, speed: 320 },
    // 2. Edge case: parked at the pad's far corner; the crane still reaches.
    { atMs: t(12.8), action: 'move', tag: H, ...RIG_SANDBOX.padCorner, speed: 280 },
    { atMs: t(16.2), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(18.2), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', keepTarget: true },
    // 3. Abort: the hauler leaves mid-reach; the crane retracts from where it is.
    { atMs: t(19.6), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(20.0), action: 'move', tag: H, x: -700, y: 1400, speed: 320 },
    { atMs: t(20.1), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', fromTip: true },
    // 4. The turret: hatch open + shut, then the turret deploys and retracts.
    { atMs: t(22.0), action: 'rigClip', structure: 'turret', clip: 'door-open' },
    { atMs: t(23.0), action: 'rigClip', structure: 'turret', clip: 'door-close' },
    { atMs: t(24.0), action: 'rigClip', structure: 'turret', clip: 'turret-deploy' },
    { atMs: t(26.5), action: 'rigClip', structure: 'turret', clip: 'turret-retract' },
    { atMs: t(29.0), action: 'end' },
  ];
}

/** E2E: the hauler is already on the pad and the crane reaches at once. */
export const RIG_SANDBOX_E2E_SCENE: unknown[] = [
  { atMs: 0, action: 'spawn', tag: 'hauler', kind: 'trader-hauler', count: 1, ...RIG_SANDBOX.pad },
  { atMs: 200, action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: 'hauler' },
];
