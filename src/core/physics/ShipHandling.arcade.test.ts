import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import type { ShipKind, ShipKindId } from '../../shared-types/shipKinds.js';
import { SHIP_SCALE } from '../../shared-types/shipScale/config.js';
import { handlingClassOf, type HandlingClass } from '../../shared-types/shipScale/arcadeHandling.js';
import { WEAPONS } from '../combat/WeaponCatalogue.js';

/**
 * Ship handling harness — "Micro Machines" arcade feel (owner, 2026-11-13:
 * "I don't mind adjustments to the health, shields and acceleration and
 * handling to make it more like micro machines and make fights a bit longer.
 * Also don't forget the afterburner to gain speed fast...").
 *
 * Drives every non-engineering kind through the REAL `PhysicsWorld` +
 * `applyShipInput` (the one path players, client prediction and the drone
 * turn use) at the shipping ship scale and measures:
 *
 *   - t90     time from rest to 90 % of cruise (s)
 *   - cruise  terminal speed on thrust alone (u/s)
 *   - boost   terminal speed on thrust + afterburner (u/s), and boostT90:
 *             time from cruise to 90 % of the way to it (s)
 *   - turn180 time to swing the nose round 180° from rest (s)
 *   - brake   distance to stop (< 5 % cruise) from cruise, reverse held (u)
 *   - slide   lateral velocity left after a 90° turn held at cruise, as a
 *             fraction of cruise (0 = on rails, 1 = ice)
 *   - ttk     seconds for one reference laser mount (no misses, no regen)
 *             to strip shield + hull
 *
 * `EQX_HANDLING_REPORT=1 pnpm vitest run src/core/physics/ShipHandling.arcade`
 * prints the table. The assertions lock the arcade feel per handling class
 * at the 2× shipping scale, so a later change can't silently make ships
 * floaty or fragile again (docs/architecture/ship-physics-handling.md,
 * "Arcade (Micro Machines) tuning, 2026-11-13").
 */

const DT = 1 / 60;
const LASER = WEAPONS.get('laser')!;
const LASER_DPS = LASER.damage / (LASER.cooldownTicks / 60);

interface Row {
  id: ShipKindId;
  cls: HandlingClass;
  t90: number;
  cruise: number;
  boost: number;
  boostT90: number;
  turn180: number;
  brake: number;
  slide: number;
  ttk: number;
}

const NO_INPUT = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };

function speedOf(w: PhysicsWorld): number {
  const s = w.getShipState('m')!;
  return Math.hypot(s.vx, s.vy);
}

async function measure(kind: ShipKind): Promise<Row> {
  const w = await PhysicsWorld.create();
  const spawn = (): void => { w.despawnShip('m'); w.spawnShip('m', 0, 0, kind.id as ShipKindId); };
  const MAX = 60 * 60;
  const TURN_MAX = 60 * 300;

  // Cruise + t90 (from rest).
  spawn();
  const trace: number[] = [];
  for (let i = 0; i < MAX; i++) {
    w.applyInput('m', { ...NO_INPUT, thrust: true });
    w.tick(DT);
    trace.push(speedOf(w));
  }
  const cruise = trace[trace.length - 1]!;
  const t90 = (trace.findIndex((v) => v >= 0.9 * cruise) + 1) * DT;

  // Afterburner from cruise.
  const boostTrace: number[] = [];
  for (let i = 0; i < MAX; i++) {
    w.applyInput('m', { ...NO_INPUT, thrust: true, boost: true });
    w.tick(DT);
    boostTrace.push(speedOf(w));
  }
  const boost = boostTrace[boostTrace.length - 1]!;
  const boostT90 = (boostTrace.findIndex((v) => v >= cruise + 0.9 * (boost - cruise)) + 1) * DT;

  // Brake from cruise (reverse held).
  spawn();
  for (let i = 0; i < MAX; i++) { w.applyInput('m', { ...NO_INPUT, thrust: true }); w.tick(DT); }
  const p0 = w.getShipState('m')!;
  let brakeTicks = 0;
  while (speedOf(w) > 0.05 * cruise && brakeTicks < MAX) {
    w.applyInput('m', { ...NO_INPUT, reverse: true });
    w.tick(DT);
    brakeTicks++;
    // Reverse thrust would back the ship up: stop once it stops closing.
    const s = w.getShipState('m')!;
    if (s.vx * p0.vx + s.vy * p0.vy <= 0) break;
  }
  const p1 = w.getShipState('m')!;
  const brake = Math.hypot(p1.x - p0.x, p1.y - p0.y);

  // Slide: from cruise, hold thrust + turn until the nose has swung 90°.
  spawn();
  for (let i = 0; i < MAX; i++) { w.applyInput('m', { ...NO_INPUT, thrust: true }); w.tick(DT); }
  let swung = 0;
  let prevA = w.getShipState('m')!.angle;
  let turnTicks = 0;
  while (swung < Math.PI / 2 && turnTicks < MAX) {
    w.applyInput('m', { ...NO_INPUT, thrust: true, turnLeft: true });
    w.tick(DT);
    turnTicks++;
    const a = w.getShipState('m')!.angle;
    swung += Math.abs(Math.atan2(Math.sin(a - prevA), Math.cos(a - prevA)));
    prevA = a;
  }
  const st = w.getShipState('m')!;
  const fx = -Math.sin(st.angle), fy = Math.cos(st.angle);
  const lat = Math.abs(st.vx * fy - st.vy * fx);
  const slide = cruise > 0 ? lat / cruise : 0;

  // 180° turn from rest (angle unwrapped: rotation() wraps at ±π).
  spawn();
  let t180 = 0;
  let turned = 0;
  prevA = w.getShipState('m')!.angle;
  while (turned < Math.PI && t180 < TURN_MAX) {
    w.applyInput('m', { ...NO_INPUT, turnLeft: true });
    w.tick(DT);
    t180++;
    const a = w.getShipState('m')!.angle;
    turned += Math.abs(Math.atan2(Math.sin(a - prevA), Math.cos(a - prevA)));
    prevA = a;
  }
  w.dispose();

  return {
    id: kind.id as ShipKindId,
    cls: handlingClassOf(kind),
    t90, cruise, boost, boostT90,
    turn180: t180 * DT,
    brake, slide,
    ttk: (kind.shieldMax + kind.maxHealth) / LASER_DPS,
  };
}

const KINDS = SHIP_KINDS_LIST.filter((k) => !k.engineeringOnly);
const TUNED = KINDS.filter((k) => handlingClassOf(k) !== 'exempt');
const rows = new Map<string, Row>();

describe.runIf(SHIP_SCALE === 2)('ship handling — arcade (Micro Machines) feel at the 2× shipping scale', () => {
  beforeAll(async () => {
    for (const k of KINDS) rows.set(k.id, await measure(k));
    if (process.env['EQX_HANDLING_REPORT'] === '1') {
      const f = (n: number, d = 2): string => n.toFixed(d);
      const lines = ['| kind | class | t90 s | cruise | boost | boost t90 s | 180° s | brake u | slide | TTK s |', '|---|---|---|---|---|---|---|---|---|---|'];
      for (const r of rows.values()) {
        lines.push(`| ${r.id} | ${r.cls} | ${f(r.t90)} | ${f(r.cruise, 0)} | ${f(r.boost, 0)} | ${f(r.boostT90)} | ${f(r.turn180)} | ${f(r.brake, 0)} | ${f(r.slide)} | ${f(r.ttk, 1)} |`);
      }
      console.log(`\nSHIP HANDLING REPORT (scale ${SHIP_SCALE}, laser ${f(LASER_DPS, 0)} dps)\n${lines.join('\n')}\n`);
    }
  }, 300_000);

  // Per-class bands. Fighters: throttle and nose snap round in well under a
  // second. Heavies a bit slower. Capitals are exempt from the arcade layer
  // (their handling comes from the WW2-grounded solver, capitalShips.test.ts):
  // the band only pins that they stay ponderous.
  const BANDS: Record<Exclude<HandlingClass, 'exempt'>, { t90: [number, number]; turn180: [number, number]; ttkMin: number }> = {
    light: { t90: [0.25, 0.8], turn180: [0.4, 0.8], ttkMin: 3.5 },
    medium: { t90: [0.4, 0.9], turn180: [0.55, 1.0], ttkMin: 5 },
    heavy: { t90: [0.15, 1.4], turn180: [0.6, 2.0], ttkMin: 10 },
    capital: { t90: [5, 60], turn180: [100, 220], ttkMin: 15 },
  };

  for (const k of TUNED) {
    it(`${k.id}: arcade handling band`, () => {
      const r = rows.get(k.id)!;
      const b = BANDS[r.cls as Exclude<HandlingClass, 'exempt'>];
      expect(r.t90).toBeGreaterThanOrEqual(b.t90[0]);
      expect(r.t90).toBeLessThanOrEqual(b.t90[1]);
      expect(r.turn180).toBeGreaterThanOrEqual(b.turn180[0]);
      expect(r.turn180).toBeLessThanOrEqual(b.turn180[1]);
      expect(r.ttk).toBeGreaterThanOrEqual(b.ttkMin);
      if (r.cls === 'capital') return;
      // The afterburner (player-flyable kinds; NPC drones close with the AI's
      // own ENGAGE_BOOST): a clearly higher top speed, 1.4–2.2× cruise, most
      // of the way there in well under a second.
      if (!k.npcOnly) {
        expect(r.boost / r.cruise).toBeGreaterThanOrEqual(1.4);
        expect(r.boost / r.cruise).toBeLessThanOrEqual(2.2);
        expect(r.boostT90).toBeLessThanOrEqual(r.cls === 'heavy' ? 1.0 : 0.7);
      }
      // A little slide when turning at speed: grip below 1, not ice.
      expect(r.slide).toBeGreaterThan(0.1);
      expect(r.slide).toBeLessThan(0.75);
      // Quick braking: stops inside ~0.4 s of travel at cruise.
      expect(r.brake).toBeLessThan(r.cruise * 0.4);
    });
  }
});
