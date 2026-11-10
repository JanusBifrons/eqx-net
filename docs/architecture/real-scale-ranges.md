# Real-scale naval ranges

The naval guns (`naval_*`: capital turrets and the coastal batteries) can run at their real ranges. It is a switch, off by default.

## The switch

| Where | How |
|---|---|
| Server (Node, tests) | env `EQX_NAVAL_RANGE=real` (anything else, or unset, is `legacy`) |
| Page | `?navalRange=real` (the inline script in `src/client/index.html` sets `__EQX_NAVAL_RANGE__` before any module loads) |
| Workers | the worker name carries `;navalRange=real` (`shipScaleWorkerName` appends `navalRangeWorkerNameSuffix`) |

It is read once at module load in `src/shared-types/combat/navalRange.ts` (the same pattern as `EQX_SHIP_SCALE` and `EQX_CAPITAL_STYLE`). The weapon catalogue is built from it at load, so the switch is per **process**, not per room.

Both sides must agree (invariant #15): the server fires from its catalogue, the client draws range rings, lock rings and aim guides from its own. The server stamps its mode on every welcome (`stampNavalRange`, sent only when `real`, so a legacy welcome is unchanged), and the client logs `naval_range_mismatch` with the fix (`?navalRange=real`) when they differ (`navalRangeMismatch`).

## The numbers (owner decision 2026-11-10)

- Ranges are real ranges in the game's own km: 1 km = 1,000 u, as the warp map counts it (a sector is ±200 km).
- Time of flight is real ÷ 3, so shell speed = real average speed × 3.
- No artificial limits: no base-gap cap, no spread. A shell hits whatever is in its path and bursts only on a hit.
- Sub-capital weapons are untouched.

**Reach is the ENGAGE reach.** The real maximum range is what a gun locks and fires at, its range ring and a coastal `weaponRange`. The shell flies on past it: `maxTicks` = the flight to max range ÷ 0.85 (the same `PROJECTILE_ENGAGE_FRAC` rule as every other projectile, ~18 % more), so a target at max range that opens the distance is still reached.

| Gun | Reach (engage) | Real flight | Game flight to reach | Speed | `maxTicks` | Full shell travel |
|---|---|---|---|---|---|---|
| `naval_s` 5"/38 | 16,600 u | 58 s | 19.3 s | 859 u/s | 1,365 | 19,542 u |
| `naval_m` 8" | 25,500 u | 72 s | 24.0 s | 1,063 u/s | 1,694 | 30,012 u |
| `naval_l` 12"/50 | 35,000 u | 84 s | 28.0 s | 1,250 u/s | 1,977 | 41,188 u |
| `naval_xl` 16"/50 | 38,700 u | 90 s | 30.0 s | 1,290 u/s | 2,118 | 45,537 u |
| `naval_siege` 80 cm Gustav | 47,000 u | 98 s | 32.7 s | 1,439 u/s | 2,306 | 55,306 u |
| `naval_xxl` 40.6 cm Lindemann | 56,000 u | 107 s | 35.7 s | 1,570 u/s | 2,518 | 65,888 u |

Legacy reaches for comparison: 2,295 / 3,542 / 4,862 / 5,376 / 6,460 / 7,735 u. Every real reach is ~7.2× the legacy one, and the ratios between guns (1 : 1.54 : 2.11 : 2.33 : 2.83 : 3.37) are the research ratios.

Gustav's blast stays 320 u (falloff 60 u) in both modes: it is a blast radius, not a range.

The tables live in `src/shared-types/combat/navalGuns.ts` (`REAL_NAVAL_GUNS`, derived `REAL_NAVAL_GUN_BALLISTICS`). Coastal `weaponRange` follows through `navalGunEngageReach`.

## What follows the switch automatically

- **Coastal structures:** `weaponRange` (range ring, placement ghost ring, turret candidate gather, defence check).
- **Capital AI:** `HostileDroneBehaviour` engages at its longest gun's reach (`mountWeaponReach`) and holds a broadside at 0.75 × that.
- **Capital turret targeting:** `mountTargetReach`.
- **Locks:** lock reach is `reach × reachSlack` (1.1); heavy guns' lock time grows with absolute distance (`absRange`, #426): ~17 s for a 16" at 30 km.
- **Client:** aim-guide length (`aimLineLength`), range rings and the lock guide all read the catalogue.

## Known gaps (follow-up slices)

- **Seeing it.** A fighter's widest view is ±6,400 u and a battleship's ±30,700 u (`shellViewHalfExtent`), so a firer cannot watch its own 16" land at 38.7 km, and a 38.7 km range ring is off screen for most hulls.
- **Far targets: what interest does and doesn't limit.** Interest (a 3×3 grid of 2,048 u cells, wider for capital pilots and wide hulls) only sets the RATE. Every drone and structure still rides the binary swarm wire out of interest: every 6 ticks (~10 Hz) while it moves, on the 1 Hz full refresh while it's parked (a parked structure every 5th refresh). Every player ship rides every snapshot (~20 Hz). The client lock-line pick and the server's `lock_track` check have no interest or distance cut-off short of reach × 1.1, so a battleship locks and hits another capital 30 km out (`tests/integration/navalReal/longRangeLock.test.ts`). The real limits:
  - **Size gate.** A 16" can't lock a fighter or a small structure near the edge of its reach: `lockSeconds` goes past `maxSeconds` (reference size 1,800 vs a 195 u signature at 74 % of reach). It is a share-of-reach rule, so legacy does the same at ~4 km. The 5" secondaries that could lock them reach only 16.6 km.
  - **Far drones' slim slice.** The `drones[]` snapshot slice (hostile bit, hp %, turret angles) is sent only in interest, so a far drone shows no hostility or damage.
  - **View extent** (above).
- **Incoming-fire warning.** No warning for the ship being shelled from 30 km yet (the proposal's risk 4).
- **Shells in flight.** Flights are ~10× longer, so ~10× more shells are alive at once. The projectile broadphase (#428) keeps hit-testing per step, so its cost doesn't grow with range, but snapshot bytes for far shells (#425) do.
- **Structure turret gather.** It scans every candidate in reach: more candidates at 38 km than at 5 km.
- **AI stand-off vs pockets.** A battleship holds broadside ~29 km from its target, often outside the pocket it was spawned to guard.
- **Hard-coded test layouts.** `coastal-duel` and `capitalEngagement` place ships at legacy ranges; they still pass under `real` (closer is in range), but the showcase framing assumes legacy.

## Tests

- `tests/unit/navalRangeSwitch.test.ts`: legacy unchanged, real matches the table and the ratios, coastal ranges follow, welcome parity, worker name.
- `tests/integration/navalReal/coastalRealRange.test.ts` (`pnpm test:naval-real`, its own CI step): a 16" barbette engages a battleship 30 km out and its shell hits it ~23 s later.
