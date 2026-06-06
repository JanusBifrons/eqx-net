# Auto-fire & facing-direction boost

_Plan: `wiggly-snowflake` (weapon-autofire-boost-mechanics)._

Two combat/feel changes so players spend attention on positioning, not trigger
discipline.

## Auto-fire (default ON)

Players never have to manually pull the trigger. When **auto-fire** is enabled
(the default), the active weapon fires automatically whenever a **valid hostile
target** is within that weapon's range. Range is per-weapon
(`weaponAutoFireRange`): the beam engages knife-fight close (250 u), bolts at
medium range (~950 u), missiles out to ~1200 u.

- A small **AUTO** toggle is always on-screen (bottom-right, desktop + touch).
  While it's ON the manual **FIRE** button is hidden — auto-fire is doing the
  work. Toggle it OFF and the original FIRE button returns.
- **Manual fire still works as an override** — Space (desktop) or the FIRE
  button (when shown) fires regardless, subject to the usual cooldown + energy.
- Auto-fire only engages **hostiles** — drones that have attacked you or been
  aggroed. Flying past neutral/ambient drones won't auto-start a fight or drain
  your energy pool on incidental targets.
- The toggle is **persisted** per-user (`settingsStorage`), so your preference
  survives reloads.

### Smarter targeting (you, and the AI)

Targeting is no longer "shoot the closest thing":

- **Weight toward the wounded.** Both your turret and the enemy AI prefer
  lower-health targets — so you (and they) finish off a nearly-dead ship instead
  of spreading damage. (Low health captures "damage already done": the more a
  target has taken, the higher its priority.)
- **Commitment / switch delay.** Targets aren't abandoned the instant another
  ship edges closer — a commitment margin (and, for the AI, a short dwell
  timer) keeps fire focused instead of flapping between near-equidistant
  targets every frame.

The enemy drone AI benefits from the same change: a pack now focus-fires the
weakest player and holds its target for a beat rather than all swivelling in
unison.

## Boost goes where you're pointing

Boost used to only multiply forward thrust **while you were already thrusting**,
so on a joystick it felt tied to the movement direction. Now **pressing boost
always pushes you along the ship's facing**, regardless of thrust/turn/reverse
input — a clean dash in the direction your nose is pointing. Boost still costs
energy each tick it's held (and is gated when the pool runs dry).

---

## Implementation notes (for maintainers)

- **Boost:** `src/core/physics/applyShipInput.ts` applies an independent forward
  impulse `thrustImpulse·(boostMultiplier−1)` when boost is held — so
  `thrust+boost` keeps the old combined magnitude and boost-alone still kicks.
  The client energy-gates the boost bit before prediction AND the send, mirroring
  the server strip, to stay in lockstep.
- **Auto-fire decision:** `ColyseusClient.tickPhysics` → `hasHostileInRange`
  over the per-frame drone-only `_lastAimTargets`. Toggle: `autoFireEnabled`
  (Zustand + persisted); UI in `AutoFireToggleButton` + conditional FIRE in
  `MobileControls`.
- **Smarter selection:** the pure `WeaponMountController.pickTarget` gained
  `healthWeight` / `switchMargin` / `dwellTicks` + a per-target `hostile` flag
  (absent options ⇒ byte-identical to before). Drone AI:
  `HostileDroneBehaviour`. Player turret: `tickLocalMountAim` (client) +
  `WeaponMountTicker.tickPlayer` (server) with the SHARED `PLAYER_AIM_*`
  constants for mount-angle lockstep. Drone HP reaches the client via the slim
  `SnapshotMessage.drones[].hp` percent.
- **Invariant #8:** the boost (core physics) + auto-fire/aim (client net + the
  drone-hp wire) changes are live-loop, so the netcode-health gate
  (`pnpm e2e:netgate`, path-filtered CI workflow) is the authoritative check.
- **Tests:** `applyShipInput.boost.test.ts`, `WeaponCatalogue.test.ts`
  (`weaponAutoFireRange`), `WeaponMountController.test.ts` (health/margin/dwell/
  hostile-flag), `HostileDroneBehaviour.test.ts` (focus-fire + dwell),
  `AutoFireToggleButton.test.tsx`, `snapshotRemoteSync.healthFrac.test.ts`;
  E2E `auto-fire.spec.ts` + `boost-facing.spec.ts` (room: `auto-fire-test`).
