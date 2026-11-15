# Coastal defences

Plan `coastal-defences` (`plans/coastal-defences.md`). Static gun batteries built the same way as the capital ships: WW2 research first (`docs/research/ww2-coastal-defences.md`), then a catalogue with the same calibres, turret art and fire control as the battleships' guns, then bases that mount them.

## The catalogue

Seven structure kinds, in the build menu's **Gun Batteries** category. Each fires one shell per barrel per salvo, spends munitions, and repeats its weapon's numbers in the catalogue (`fireRateMs`, `weaponDamage`, locked by `tests/unit/coastalDefences.test.ts`). A naval gun's `weaponRange` is derived from the gun itself (`navalGunEngageReach`, `src/shared-types/combat/navalGuns.ts`), so the two cannot drift; the quad 40 mm's stays a literal.

| Kind | Real counterpart | Gun | Barrels | Arc | Reach | Prefers |
|---|---|---|---|---|---|---|
| Quad 40 mm AA | Quad Bofors | autocannon | 4, in turn | all round | ~1,070 | fighters |
| 5" DP Mount | Twin 5"/38 | `naval_s` | 2 | all round | ~2,300 | gunships, light capitals |
| 8" Casemate | Batterie Hamburg 24 cm | `naval_m` | 1 | 120° | ~3,540 | capitals |
| 11" Triple Turret | Austrått (Gneisenau's turret) | `naval_l` | 3 | all round | ~4,860 | capitals |
| 16" Barbette | US 16"/50, casemated | `naval_xl` | 2 | 144° | ~5,380 | capitals |
| 40.6 cm Super Battery | Batterie Lindemann | `naval_xxl` | 1 | 120° | ~7,740 | capitals |
| 80 cm Siege Gun | Schwerer Gustav | `naval_siege` | 1 | 60° | ~6,460 | capitals |

**Real ranges (switch, off by default).** With `EQX_NAVAL_RANGE=real` on the server and `?navalRange=real` on the client, each gun reaches its real range in the game's km (1 km = 1,000 u) and its shell flies a third of the real time: 5" 16,600 u (19 s), 8" 25,500 u (24 s), 11" 35,000 u (28 s), 16" 38,700 u (30 s), Lindemann 56,000 u (36 s), Gustav 47,000 u (33 s; blast still 320 u). The `weaponRange` above follows the gun, so the range ring, the turret's target search and its lock all grow with it. Numbers and gaps: [real-scale-ranges.md](../architecture/real-scale-ranges.md).

- **Bigger than ships.** The two super-guns use new weapons. The Lindemann out-ranges every ship gun (its light coast shell reached 56 km against the Iowa's 38.7 km). The siege gun fires once every two minutes, and its shell bursts where it hits, hurting everything within 320 u (`ProjectileWeaponDef.splash`, `shellBlastDamage`). Every naval shell hits the first thing in its path; one that hits nothing just ends at the end of its flight, with no burst and no splash (owner, 2026-11-10: "hit anything in-between if it's there, but only explode on target").
- **Same size as the ship gun.** A battery's gunhouse and barrels are the ship turret of the same calibre (`structureNavalTurret`, sized from the beam of the ship class that carries it), drawn by the same naval turret art, with the shot leaving the drawn barrel tip (`structureMountMuzzle`, #15).
- **Casemates face their embrasure.** A gun with an arc trains only through it, turned with the structure's rotation (rotation 0 faces +y).
- **Reach is the gun's, at every level.** Upgrading a battery raises its damage and hull, never its reach: each Reach above is within its shell's flight, and a levelled reach would lock targets the shells can't get to. The inspector's range ring and the placement ghost both draw the catalogue reach (`StructureMountTicker.test.ts` locks reach ≤ flight for every gun kind at the level cap).
- **Reload and arc on screen.** The structure inspector shows one line per gun size, read from the catalogue (`components/structureGunLines.ts`): `16" ×2 · reload 30 s · arc 144°`, or `all round`. While placing, the ghost draws a faint wedge for each arc-limited gun out to its range, turned with the placement rotation (`ConnectorRenderer.drawPlacementPreview`, pure angles in `connectorVisual.arcWedgeScreenAnglesInto`).
- **The four energy and missile turrets are unchanged** (their records, and so every saved structure, stay valid). They now aim with the same fire control.

## Fire control

Every defence structure runs the capital-ship rules (`core/combat/mountFireControl.ts`, shared with `WeaponMountTicker.tickCapitalMounts`), mount by mount, in `server/structures/StructureMountTicker.ts`:

- each mount keeps its own target: the hostile its calibre prefers (`mountPriority`), among those in reach, in its arc and slow enough across its sights to track (`canTrack`). A 16" can't follow a fighter darting past; the AA can;
- it holds a target through a brief loss (1 s), leads it for its shell speed, turns at its traverse rate (16" 0.07 rad/s, AA 0.45 rad/s) and fires only when on target;
- the room hands it every hostile in reach with velocity and class (`SectorRoom.collectTurretTargets`, grid `within` query).

It runs on the 100 ms turret tick using real elapsed time. The **server is the only writer of the angles** (#12): they ride the snapshot (`structureMountAngles`, milliradians, only for guns off their rest bearing), and the client eases its drawn barrels toward them.

## In the bases

`growBase` (version 10) buys a defence mix by tier, from its own random stream so the guns never shift anything else a base builds:

| Tier | Defences |
|---|---|
| Outpost | a laser or bolt turret, sometimes a quad AA |
| Settlement | + quad AA, one or two 5" mounts |
| Stronghold | two light turrets, AA, two 5", an 8" casemate or 11" triple |
| Citadel | + a second AA, a 16" barbette, sometimes a Lindemann |
| Military | every gun but the heaviest, repeated while wealth lasts |

- **Region hearts mount the super-guns**: the 80 cm siege gun (one per region) and the 40.6 cm battery, funded on top of the base's wealth. The heart's garrison gets them, or the stronghold or citadel that holds the heart alone (`galaxyBases.withSuperGuns`).
- **Bastions seat the biggest guns first** in the outward slot (standing off past the hub so smaller guns fit above and below), and arc-limited guns face out from the base. Unfenced bases face theirs away from the Capital.
- Every galaxy sector's bases still find a site (`galaxyBases.test.ts`).
- **In code:** the mix comes from `defenceMix` on its own random stream (`DEFENCE_STREAM`). `profile.superGuns` are bought first. Arc-limited guns (`ARC_LIMITED`) get a `rot` facing out. `TURRET_KINDS` (exported) is every gun kind; tests count guns with it, never a name regex. A naval gun on a structure is sized by `structureNavalTurret` and fires from `structureMountMuzzle` (#15).

## Tests

- `server/structures/StructureMountTicker.test.ts` — arcs and rotation, traverse, tracking, calibre priority, lead, reload.
- `server/rooms/ProjectilePipeline.blast.test.ts` — the siege shell's blast.
- `tests/unit/coastalDefences.test.ts` — catalogue numbers, gun sizes, muzzles.
- `core/bases/growBase.test.ts`, `galaxyBases.test.ts`, `military.test.ts` — the mix, facing, super-guns, fit.
- `tests/integration/sectorRoom/coastalDefences.test.ts` — the showcase gun line powers up and every battery fires in a real room.

## Showcase

Rooms `showcase-coastal` (the whole line on a range), `showcase-coastal-aa` (an AA screen against a fighter pack), `showcase-coastal-duel` (a battery against a battleship) and `showcase-garrison` (a region-heart garrison with its super-guns). Shots in `showcase/shots/coastalDefences.ts`.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Defence fire control (plan coastal-defences)

- `StructureGridSubsystem.tickTurrets` (100 ms turret tick) runs `StructureMountTicker` for every built, powered defence structure: per-mount target by calibre priority, arc (turned by `rec.rot`), tracking, lead, traverse at real elapsed time, fire when on target. The old nearest-target/instant-aim path is gone; `findNearestDrone` is only the unit-harness fallback for `turretTargets`.
- **Lock to fire (root invariant #19):** each mount fires only with a COMPLETED lock on its current target, kept in a pre-allocated per-mount `LockEntry` (`stepLock` on the turret tick's real dt). Lock time = `lockSeconds` with the mount size's `WEAPON_LOCK_PROFILE`, the structure's reach, the target's `signature` (hull radius, on `TurretTargetView`), its motion, and `STRUCTURE_SENSOR` (1.5); a lock past `maxSeconds` is capped there rather than impossible (`clampAtMax`: a fixed battery is never blind on its only target), and a heavy M/L/XL gun then stretches it for ABSOLUTE distance, uncapped (a long shot takes ages by design; `lockTime.ts`). A new target restarts the lock; out of reach past `lostGraceSeconds` restarts it. Targeting, arcs and traverse are unchanged. testMode `instantLock` on any join makes that room's structure locks instant (`setInstantTurretLocks`). Lock: `StructureMountTicker.test.ts`.
- `turretTargets` = `SectorRoom.collectTurretTargets`: every hostile in reach (same rules as `findNearestTurretTarget`), with velocity and `targetClass`, from the turret target grids' `within` query, into pooled views (#14).
- The server is the only writer of structure mount angles (#12): `rebuildStructureMountAngles` packs them each turret tick into `snapshot.structureMountAngles` (`encodeStructureMountAngles`); the client eases toward them.
- A naval mount fires one shell per barrel (quad AA one barrel per shot) from `structureMountMuzzle`; one munition per salvo. A projectile weapon with `splash` (the siege gun) bursts on a hit only (`ProjectilePipeline.blast`, `shell_blast` message for the visual). A shell that hits nothing ends silently at the end of its flight, with no burst and no splash (owner 2026-11-10); no `shell_end` is sent, so the client draws no burst (#15 lock: `tests/unit/navalShellMissParity.test.ts`).
