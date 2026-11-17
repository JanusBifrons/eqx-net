# Shells as events (design note)

Status: **built (slices 0–4, 2026-11-12).** Every naval shell travels only as events: there is no switch, and none rides `projectiles[]`. The "as built" sections at the end describe each slice. Handoff 2026-11-10, Next #3: "Shells as events (spawn/land on the wire). This fixes the false burst at the edge of the view and the incoming-fire countdown estimate, and it's needed before big fleets."

A naval shell (`naval_*`) flies in a straight line at a constant speed until it hits something or runs out of flight. Today the server re-sends every live shell in every snapshot. This note replaces that with one message when a salvo is fired and one when a shell hits, with the client drawing the flight from a shared function. It keeps invariant #16 with a compact in-flight list in the join payload and a slow keyframe on the snapshot.

## 1. The problem today

**How a shell travels.** `ProjectilePipeline` holds a `ProjectileRecord` (`x, y, vx, vy, ownerId, birthTick, damage, radius, maxTicks, weaponId`; `ProjectilePipeline.ts:47`). Each tick it adds `vx·dt, vy·dt` and ends the shell when `serverTick − birthTick ≥ maxTicks` (`ProjectilePipeline.ts:300`). Velocity never changes: no drag, no spread, no randomness (owner decision 2026-11-10). So the whole flight is known the tick the shell is fired.

**How it is sent.** Every 20 Hz snapshot carries `projectiles[]` (`{ id, x, y, vx, vy, ownerId, weaponId }`, `snapshotMessages.ts:270`), filled per recipient in `SnapshotBroadcaster` (`:871–910`). A naval shell rides a viewer's snapshot while the shell OR its straight-line fall point is inside `shellViewHalfExtent(viewer kind)` (`navalShellInView`, `:98`), else by the wide-owner rule. Ids are strings `p-N` (`CombatSubsystem.nextProjectileId`).

**What it costs.** About 38 B per shell per snapshot (server CLAUDE.md, slice 7), so **~760 B/s per live shell per viewer**. At real range (`real-scale-ranges.md`) a 16" flies up to `maxTicks` 2,118 (35 s) against ~4 s in legacy, so ~10× more shells are alive at once:

| Case (per viewer) | Live shells | Snapshot bytes today |
|---|---|---|
| One battleship, 9-shell 16" broadside, real range | 9 for ~35 s | ~6.8 KB/s, ~240 KB per salvo |
| 10 battleships, a broadside each per 30 s reload | ~105 | ~80 KB/s |
| Same fleet, legacy range | ~12 | ~9 KB/s |

80 KB/s is more than a whole client's baseline (the `fleet-fight` scene budget is 334 KB/s rx for everything). The projectile broadphase (#428) keeps the server's hit-testing flat; the wire is what grows.

**The two bugs, and why they live in the wire.** The client never learns how a shell ended, so it guesses from absence:

- **False burst at the edge of the view.** `NavalShellBursts` bursts where a shell was last seen if it vanished before 80 % of full travel (`shellEndedOnHit`, `turretFx.ts:155`). A shell that leaves the viewer's interest mid-flight also vanishes early, so it bursts in empty space.
- **Countdown estimate.** The client doesn't know `birthTick`, so `shellRemainingS` (`incomingFire.ts:63`) assumes "first seen ≈ fired". Each shell of a salvo is first seen on a slightly different snapshot, and the soonest-arrival pick changes as each lands, so the owner saw the countdown reset per shell.

## 2. Wire design

Two server → client messages, JSON, zod-validated on arrival (#3; schemas in `src/shared-types/messages/shellEvents.ts`). Salvos are rare (a 16" reloads in 30 s), so JSON is fine; binary buys nothing until fleets are far larger.

**`shell_salvo`**: one per firer per tick, holding every shell that firer fired that tick (all barrels of all turrets that went off together).

```ts
ShellSalvoSchema = z.object({
  type: z.literal('shell_salvo'),
  s: z.number().int().nonnegative(),      // salvo id (per room, increments)
  o: z.string().min(1).max(64),           // owner on the wire (wireOwnerId: swarm-<eid> or playerId)
  w: NavalWeaponIdSchema,                 // naval_s|m|l|xl|xxl|siege
  t: z.number().int().nonnegative(),      // fire tick (the shells' birthTick)
  n: z.number().int().positive(),         // maxTicks (flight in ticks)
  g: z.string().min(1).max(64).optional(),// the firer's locked target, when it has one
  sh: z.array(z.tuple([
    z.string().min(1).max(32),            // shell id (the existing p-N)
    z.number(), z.number(),               // origin x, y at tick t (0.1 u)
    z.number(), z.number(),               // vx, vy in u/s (0.01 u/s)
  ])).min(1).max(64),
}).strict();
```

Velocity, not a target point: the lead aim is already in the velocity, the fall point is `origin + v·n/60`, and a target point would need a divide on the client. No seed: there is no randomness to reproduce. If spread ever returns, a `u32` seed per salvo goes in here.

**Quantise once, on the server, before the first step.** The spawn path rounds the record's `x, y, vx, vy` to the wire precision when the shell is created, so server and client integrate the same numbers (#15). Without it a 35 s flight drifts by the rounding × 2,118 steps.

**`shell_end`**: hits only, batched per tick.

```ts
ShellEndSchema = z.object({
  type: z.literal('shell_end'),
  e: z.array(z.tuple([
    z.string().min(1).max(32),   // shell id
    z.number().int(),            // tick of the hit
    z.number(), z.number(),      // hit point
    z.number().nonnegative(),    // blast radius (0 = none; replaces shell_blast for shells)
    z.literal(1).optional(),     // continues: a pass-through kill (railgun); the shell flies on
  ])).min(1).max(256),
}).strict();
```

A miss sends nothing: the client knows `t + n` and ends the shell there silently, which is the rule already (misses end with no burst). A shell stopped by a shield fence is a hit with radius 0 at the wall. Damage numbers keep their own `DamageEvent`.

**Size.** A 9-shell salvo is ~60 B of header + ~45 B per shell ≈ 470 B, once. Each hit is ~35 B.

## 3. Who receives it

A viewer gets a salvo if any of these holds, decided per shell, at fire time:

1. **The flight crosses the viewer's view.** The segment origin → fall point meets the square of half-extent `shellViewHalfExtent(viewer kind)` (a new shared `shellSegmentInView`, slab test, alloc-free). This replaces today's "shell or fall point in view", which misses a shell that crosses the view mid-path.
2. **The viewer fired it, or is its target** (`g` is the viewer's ship).
3. **The owner is a wide entity in the viewer's interest** (today's rule, so a capital's broadside is seen leaving the barrels). The rule covers every owner, whoever flies the hull: a swarm capital by its registry entity in `interestScratch`; a player capital (owner = playerId, or its shipInstanceId while AI-flown or lingering) by its hull cell against the viewer's window (`SnapshotBroadcaster.noteInterestWindow`, recorded by the swarm broadcast): in view when the Chebyshev cell distance is at most viewer reach + `ceil(hull radius / CELL_SIZE)`, the same test `SpatialGrid` uses for a wide swarm entity. Lock: `SnapshotBroadcaster.pilotCapitalShots.test.ts`.

The viewer moves during a 35 s flight, so the server keeps, per recipient, a stamp of which live shells it has sent (generation counter on a pooled per-client slot, #14). On the 1 Hz keyframe tick (§5) it re-tests unsent live shells against the viewer's current pose and sends any that now qualify as a `shell_salvo` holding just those shells. `shell_end` goes to every recipient whose stamp says it has the shell.

When the flag is on, naval shells leave the per-tick `projectiles[]` loop for event-capable clients (the `NAVAL_SHELL_IDS` branch skips them). Sub-capital bolts are unchanged: their flights are short and the ±3,072 u box already bounds them. That box is the viewer's cell window half-width, `CELL_SIZE × (reach + 0.5)`: ±3,072 u (1.5 cells) for every small hull, wider for a viewer flying a capital, whose window grows with its hull.

## 4. Drawing the flight

**One shared function** (#15), in `src/core/combat/shellFlight.ts`:

```ts
shellPoseAt(x0, y0, vx, vy, fireTick, tick, out): void   // out.x/y = origin + v·(tick − fireTick)/60
```

The server keeps its Euler step (the broadphase needs per-step boxes); a parity test checks `shellPoseAt` against `ProjectilePipeline` stepping a quantised record for the full `maxTicks` of every naval gun (drift < 0.01 u).

**The client** turns a `shell_salvo` into pooled `mirror.projectiles` entries (same map, flagged `event: true` so `syncProjectiles` neither adds nor drops them) and each frame sets their pose with `shellPoseAt` at the **display tick**: the estimated server tick minus the remote-entity display delay, the same timeline the drones and remote ships are drawn on. That way a shell meets its target where the target is drawn.

**The server stays hit-authoritative.** On `shell_end` the client queues the end at its hit tick on the display clock (the message arrives before the drawn shell gets there), then removes the shell and bursts at the hit point with the blast radius. With no `shell_end`, the shell fades at `t + n`: no burst. `NavalShellBursts` loses its absence guess entirely, which removes the false edge burst by construction.

## 5. Invariant #16: rebuilding from snapshot ∪ join

Events are accelerants. The source of truth is the in-flight list, carried in two places:

- **Join payload.** The welcome carries `shellsInFlight`: every live shell that passes the §3 test for the joining ship, in `shell_salvo` form (grouped by salvo). A late joiner and a sector arrival (transit is a fresh join) see shells already in the air.
- **Snapshot keyframe.** Each snapshot carries an optional `shellKey` slice: in-flight records (same tuple + salvo header fields), round-robin over the recipient's sent set, so each live shell is re-sent once every 2 s (at most 8 records per snapshot, so past ~320 live shells the period stretches). The client adopts an unknown id and ignores a known one. A shell that stops appearing in keyframes past its expected turn plus 1 s is dropped silently (no burst).

What each failure looks like:

| Case | Converges via | Worst visible effect |
|---|---|---|
| Late joiner, transit arrival | join `shellsInFlight` | none |
| Lost `shell_salvo` (WebRTC unreliable channel, a backpressure drop, a reconnect) | keyframe within ~2 s | the shell appears up to ~2 s into its 35 s flight |
| Lost `shell_end` | keyframe stops listing it | no burst; the shell vanishes at its next missed turn instead of at the hit |
| Viewer zooms or flies so a shell's path enters view | §3 re-test at 1 Hz | the shell appears up to 1 s late |
| Firer or target warps out | nothing new: shells fly on and end as misses | none |

Shells never cross sectors, so a sector handoff is just a fresh join.

## 6. The incoming-fire countdown

With `t`, `n` and the exact path, `predictShellPass` gets the exact time of each shell's closest approach to the local ship, not an estimate from "first seen". `IncomingFireWarning` groups by **salvo id** (then by fall area, as now, for salvos from several firers landing together) and shows one marker per group. Its countdown is the time to the group's first dangerous pass on the display clock, computed from fixed ticks, so it falls smoothly and never resets when a shell lands or a new one is first seen. When that shell passes, the label moves on to the next dangerous shell in the group only if it is more than `JOIN_DT_S` (2 s) later; otherwise the marker shows "now" until the group is done.

## 7. Migration in slices

Slices 1–3 ran behind `EQX_SHELL_EVENTS=1` (per process, read once, like `EQX_NAVAL_RANGE`); slice 4 removed the switch. The server stamps it on the welcome; the client consumes events only when its welcome says so, so the two sides can't disagree (#15) and no page flag is needed. Each slice is one PR (~10–20 min agent).

| Slice | Change | Tests | Gates |
|---|---|---|---|
| 0 | Shared `shellPoseAt`, `shellSegmentInView`, wire quantise; quantise at spawn | Parity vs `ProjectilePipeline` per naval gun; segment-in-view property test (fast-check) incl. a path crossing the view with both ends outside | unit |
| 1 | Server emits `shell_salvo` / `shell_end`, join `shellsInFlight`, `shellKey` keyframe; per-tick shells still sent | Schemas in `messages.test.ts`; `SnapshotBroadcaster.shellEvents.test.ts` (who receives, re-test on move, keyframe rotation, alloc-free); integration under `navalReal/`: a 16" hit's `shell_end` tick and point match the `DamageEvent` | netgate `core` (touches SnapshotBroadcaster + messages) |
| 2a | Client: countdown per salvo | **Failing first (#13):** a 9-shell salvo whose shells are first seen on different snapshots; the drawn countdown must never go up (fails today) | unit + E2E probe on `coastal-duel` with `?navalRange=real` |
| 2b | Client: draw from events, burst only on `shell_end` | **Failing first:** a shell that leaves the viewer's interest at half travel must not burst. Write it at the client-ingest level (snapshot sequence → `syncProjectiles` → `NavalShellBursts`), where the bug lives; it fails today | unit + netgate `core` |
| 3 | Drop naval shells from `projectiles[]` for event clients | Broadcaster test: no naval entry when the welcome says events; count budget on snapshot bytes | netgate `core`; perf scenes with a new `naval-broadside` scene (real range, 10 battleships): rx KB/s base vs head, ≥ 4 reps |
| 4 | Default on, delete `navalShellInView`'s fall-point rule and the absence guess, update `real-scale-ranges.md`, the server CLAUDE.md naval-shell bullets and the showcase registry | Existing suites green with the flag removed | netgate, perf scenes |

**Byte budget** (per viewer, the 10-battleship case):

| | Today | With events |
|---|---|---|
| Spawns | n/a | 10 × 470 B / 30 s ≈ 0.16 KB/s |
| Hits | n/a | ≤ 105 × 35 B / 35 s ≈ 0.1 KB/s |
| Keyframe | n/a | 105 × ~45 B / 2 s ≈ 2.4 KB/s (cap: 8 × 45 B × 20 Hz ≈ 7 KB/s) |
| Per-tick shells | ~80 KB/s | 0 |
| **Total** | **~80 KB/s** | **~2.7 KB/s** (~30× less) |

The keyframe dominates; it is the price of #16, and its period (2 s) is a tuning knob, not a design choice.

## 8. Defaults chosen (owner can override)

These were settled on the owner's standing rule: record the game as it is and show everything, and only ask about real design calls. Change any of them in the slice that builds it.

1. **Salvo countdown:** count down to the **first** shell's arrival (the moment you need to move). The marker stays up until the last shell of the salvo has landed or passed.
2. **Shells you're not part of:** **show them.** A shell whose path crosses your screen is drawn even when you're far from both the gun and the target (§3). It costs little data, and hiding real fire breaks "show everything".
3. **Incoming markers:** for **your own ship only**, as today. Friends and structures are a later, separate decision.
4. **Other guns:** fighter and turret bolts **stay as they are**. Their flights last a few seconds, so per-tick sending is cheap; revisit only if a perf scene says otherwise.

## Slice 1 as built (2026-11-11)

- **Where:** `ShellEventHub` (`src/server/rooms/ShellEventHub.ts`) routes event shells; `ProjectilePipeline` reports them through `onShellSpawn` / `onShellEnd` / `onShellExpire` when its `shellEvents` dep is on; schemas and the switch are in `src/shared-types/messages/shellEvents.ts`. The room turns it on from `EQX_SHELL_EVENTS=1`, or the testMode room option `shellEvents` (tests and showcases, without flipping the whole process).
- **The pose follows the worker tick, not the room update (a change from §4).** The room calls `advance()` once per update, but `serverTick` is the physics worker's counter, which can skip or repeat a tick when the two drift. The Euler step moved a shell once per update while its lifetime counted worker ticks, so the server's shell slid off `shellPoseAt`. An event shell now sweeps from its pose to `shellPoseAt(…, serverTick + 1)` each advance: a skipped tick makes the step longer (no tunnelling), a repeated one makes it zero. Bolts and flag-off shells keep the Euler step. Lock: `ProjectilePipeline.shellEvents.test.ts`.
- **The path ends one step past the fall point.** The last advance runs at `t + n` and sweeps to the pose at `t + n + 1`, so `shellPathEndTick(t, n) = t + n + 1` is the end for the view segment and the miss rule (`src/core/combat/shellFlight.ts`). Slice 2b must end a missed shell there, not at `t + n`.
- **Shared core helpers** (`src/core/combat/shellFlight.ts`, pure, alloc-free, out objects): `shellPoseAt` (closed form of the Euler step: pose after `tick − fireTick` steps), `shellSegmentInView` (segment vs view square, inclusive, division-free SAT) and the wire quantisers (`quantiseShellSpawn`: x/y to 0.1 u, vx/vy to 0.01 u/s; the server quantises a naval shell at spawn). `NAVAL_SHELL_WEAPON_IDS` is the one naval id list. Locks: `shellFlight.test.ts` (fast-check vs a slab oracle) and `tests/unit/shellFlightParity.test.ts` (every naval gun, both range modes, real pipeline, drift < 0.01 u; `SHELL_TICK_DT_S === DT_SEC`).
- **Salvo grouping:** consecutive spawns of one owner and one gun in one tick share a salvo id (every caller fires a turret's barrels back to back).
- **Shield walls:** a wall stop is a `shell_end` with radius 0 at the shell's pose at the START of the step that crossed the wall (`wallBlocksProjectile` doesn't return the crossing point).
- **Not yet:** `g` (the firer's locked target) is never filled: the hub has the `fireTargetOf` seam, but nothing wires it. Rule 1 (the path crosses your view) already covers a targeted viewer, since the fall point is at the target.
- **Cost:** the hub allocates nothing once warm (pooled records, messages and tuples; per-viewer state is a slot in fixed typed arrays, max `SHELL_MAX_VIEWERS` = 128). A flush with nothing to send never visits the viewers.
- **Locks:** `ShellEventHub.test.ts` (who receives, re-test on move, ends routing, keyframe rotation, join backlog, slot reuse), `ProjectilePipeline.shellEvents.test.ts`, `src/shared-types/messages/shellEvents.test.ts`, `tests/integration/sectorRoom/shellEvents.test.ts` (a 16" hit: the target gets the salvo, `shell_end` carries the `DamageEvent` point and lies on the closed-form step).

## Slice 2a as built (2026-11-12)

- **Ingest:** `ColyseusClient` reads `shell_salvo` / `shell_end` only when its welcome says `shellEvents: true`, and takes `shellsInFlight` from the welcome and `shellKey` from each snapshot. They feed `net/shellSalvoStore.ts`, which keeps `mirror.shellSalvos` (salvo id, fire tick, flight, origin per shell, keyed by the shell's projectile id; pooled records). A shell leaves on its `shell_end`, or once the server tick passes `shellPathEndTick`.
- **Countdown:** `IncomingFireWarning` uses the salvo's origin for an exact remaining flight, groups a salvo's shells into one marker (`groupShellPasses` with salvo ids; other salvos still merge by fall area and arrival), and holds a per-salvo deadline. The deadline can move earlier; it moves later only to a shell more than `JOIN_DT_S` after a deadline that has passed. Otherwise the marker reads "now" until the salvo is done (`groupLabel`, shared with the edge radar). Groups with no salvo (events off) are unchanged.
- **Locks:** `IncomingFireWarning.test.ts` (a 9-shell salvo first seen on different snapshots: the countdown never goes up; failed before as `0.1 → 0.2`; a later salvo keeps its own marker), `shellSalvoStore.test.ts`.
- **Not yet:** the E2E probe on `coastal-duel` with `?navalRange=real` (design slice 2a row). The client still draws shells from the per-tick `projectiles[]` (slice 2b).

## Slice 2b as built (2026-11-12): drawn from events, burst on `shell_end`

- **Drawing:** each frame `ColyseusClient` computes the display tick (`clockAnchorServerTick + (now − clockAnchorPerfNow) / tick − DISPLAY_DELAY_MS / tick`, the timeline drones and remote ships are drawn on), where `now` is the FRAME's own time (the RAF stamp `updateMirror(frameNowMs)` gets, in game time), never the clock read mid-frame: that has run on by the frame's snapshot work, which lands on alternate frames, so a railgun slug stepped ~1/3 then ~5/3 of a frame (rail take 6; lock `ColyseusClient.shellFrameTime.test.ts`) and `ShellSalvoStore.place()` puts every live salvo shell into `mirror.projectiles` at `shellPoseAt(displayTick)`, flagged `event: true`, from its fire tick to `shellPathEndTick`. `syncProjectiles` neither overwrites nor deletes `event` entries, and the per-frame advance skips them. The per-tick `projectiles[]` copy (same id) is ignored once a shell is event-drawn; slice 3 stops sending it.
- **Hits:** `shell_end` only marks a shell (tick and point). When the display tick reaches the hit, `place()` queues `[x, y, shellRadius]` into `mirror.pendingShellEnds` (one-frame queue, `consumeOneFrameTriggers`) and removes the shell, so the burst lands where the drawn shell is. An end for a shell never seen bursts at once. A miss is removed silently past `shellPathEndTick`.
- **No false edge burst:** `NavalShellBursts` never bursts an `event` shell because it disappeared (it may only have left the viewer's interest). A shell this viewer got only per tick keeps the old guess until slice 3.
- **Locks:** `navalShellBursts.test.ts` ("a shell drawn from events that leaves the view at half travel does not burst", which failed first as a burst at (3000, 0)), `shellSalvoStore.test.ts` (closed-form pose at the display tick, nothing before the fire tick, hit bursts on the display clock, miss removed silently, snapshot sync leaves event shells alone).

## Slice 3 as built (2026-11-12): naval shells leave `projectiles[]`

- With the room's hub on (`EQX_SHELL_EVENTS=1` or the testMode `shellEvents` option), every client's welcome says `shellEvents`, so `SnapshotBroadcaster` skips every naval shell in the per-tick `projectiles[]` loop (one check per recipient). Sub-capital bolts are unchanged. The shells reach a viewer only by the hub's rules (§3): salvo, 1 Hz re-test, join backlog, keyframe.
- **Locks:** `SnapshotBroadcaster.navalShells.test.ts` ("events on: the 16\" shell is not in projectiles[]; a bolt in the box still is", failing first; "events off: unchanged"); `tests/integration/sectorRoom/shellEvents.test.ts` (no naval shell rides a snapshot in an events room).
- **Measured (2026-11-12, `naval-broadside` perf scene).** Ten hostile battleships fire on a battleship pilot 15 km off at real range. NPC capital turrets engage pilots and structures, never other NPCs, and a main gun never locks a fighter, hence the capital pilot. Same commit, `--base-env EQX_NAVAL_RANGE=real` vs `--head-env "EQX_NAVAL_RANGE=real&EQX_SHELL_EVENTS=1"`, 4 reps per arm on the laptop: **GREEN, rx 254 → 67 KB/s per pilot (×0.26, p = 0.03)**. Entities per JSON snapshot went 100 → 1; frame p95, render p95 and server tick p95 are unchanged. The command is in `perf-scenes.md`. Slice 4 (default on, delete `navalShellInView`'s fall-point rule and the absence guess) follows it.

## Slice 4 as built (2026-11-12): on everywhere, no switch

- **Server:** every room builds a `ShellEventHub`. `EQX_SHELL_EVENTS`, the testMode `shellEvents` room option and `ProjectilePipeline`'s `shellEvents` dep are gone: every naval shell is quantised at spawn and follows `shellPoseAt` on the worker tick. `SnapshotBroadcaster` skips every naval shell in `projectiles[]`, so `navalShellInView` (the fall-point rule) is deleted. The hub's viewer rule still sizes the view with `shellViewHalfExtent` (#15 with the client zoom floor).
- **Welcome:** it still says `shellEvents: true`, and the client still reads events only then (the handshake is kept as a version check; it is now always true).
- **Client:** `NavalShellBursts` lost its absence guess (`shellEndedOnHit` is deleted): it bursts only the `[x, y, shellRadius]` triples `ShellSalvoStore.place()` queues when the display reaches a `shell_end`. A miss, or a shell leaving view, never bursts.
- **Measured:** the `naval-broadside` perf scene (slice 3 row): rx per pilot 254 → 67 KB/s, ×0.26, p = 0.03, with no frame or tick regression.
- **Locks:** `SnapshotBroadcaster.navalShells.test.ts` (no calibre ever in `projectiles[]`), `navalShellBursts.test.ts` (no `shell_end`, no burst; the burst lands on the drawn point), `tests/unit/navalShellMissParity.test.ts` (a miss expires with no `shell_end` and the client draws nothing, every naval gun), and the integration tests `capitalEngagement`, `coastalDefences`, `coastalDuel` and `shellEvents`, which now observe `shell_salvo`.

## Railgun pass-through (2026-11-14)

Plan "beam slices, railgun channels, capital heavy beams", step 7. The capital
railgun's slug is a naval event shell (`'railgun'` is in
`NAVAL_SHELL_WEAPON_IDS` and `NavalWeaponIdSchema`), very fast and flat
(`RAILGUN_BALLISTICS`, `shared-types/combat/navalGuns.ts`: 5× the 16"
shell's speed, at least its reach). Its weapon has a channel `killCut`, which
makes it a PASS-THROUGH shell:

- **Server (`ProjectilePipeline`).** `applyDamage` returns whether the hit
  destroyed the target. When it did and the shell passes through
  (`passesThrough(weaponId)`: a channel `killCut`), the shell is not dropped:
  it looks again along the rest of the same step (victims excluded, at most
  `MAX_PASS_HITS_PER_STEP` per step) at FULL damage, and carries on. It ends at
  the first target that survives a hit (`shell_end` as usual) or at the end
  of its flight (silent). A pooled per-shell victim list (`ProjectileRecord.hits`)
  means it never hits one target twice. It skips capital wreck pieces (kind 4)
  in `canHitSwarm`: "the slug ignores debris" (owner).
- **Wire.** No new message: the `shell_end` tuple gets an optional 6th
  element `continues: 1`. `ShellEventHub.onEnd(…, continues)` queues a pooled
  pass-through hit and does NOT retire the shell, so re-tests, keyframes and
  the join payload keep describing the live slug (#16). In a flush the
  pass-through tuples go before the final ends, so a slug that kills and then
  stops in one flush arrives in order.
- **Client.** `ShellSalvoStore.applyEnd` queues a continues tuple as a burst
  for when the display reaches its tick and leaves the shell unended, so it
  keeps drawing and `navalHitHold` still holds the next victim's hit (its
  `onShellEnd` matches by point, so the passed victim's flash is released at
  that burst, not at the timeout). The burst is sized by `shellBurstSize`
  (`turretFx.ts`; the railgun's small 5 u slug bursts at
  `RAILGUN_BURST_MUL` × its radius).
- **Locks:** `ProjectilePipeline.passThrough.test.ts`, `ShellEventHub.test.ts`
  "pass-through", `shellSalvoStore.test.ts` "pass-through",
  `ColyseusClient.navalHitFlash.test.ts` "railgun",
  `tests/integration/sectorRoom/railgun.test.ts`.

## Kills wait for the drawn shell (2026-11-15)

Rail take 6 review: the cruiser split 3-5 frames before the drawn slug reached
its hull (damage number at 4.933 s, split at 4.950 s, slug tip at the hull
~5.0-5.03 s). Two timelines: the slug is drawn at the display tick (about
`DISPLAY_DELAY_MS` + RTT/2 behind the server) and its hit's FX were held for
it (`navalHitHold`), but the `destroy` event, sent in the same flush as the
damage, ran `killSwarmEntity` on arrival: the hull left the mirror, the
explosion fired, `flushQueuedDamageFx` released the held number (4.933), and
the dying-hull hold handed the hull to its wreck pieces as soon as they
arrived (the next frame, 4.950). All on the arrival timeline, ~100 ms early.

Now (`net/drawnShellTiming.ts`, `DrawnShellTiming.deferKill` / `release`):

- A `destroy` for a swarm ship whose KILLING hit (the damage event just
  before it, `newHealth` 0) is still held for its drawn shell
  (`NavalHitHold.holdsKill`) does not kill it: the ship stays in the mirror,
  drawn alive on the display timeline, and the decoder's full-snapshot sweep
  skips it (`decodeSwarmPacket(…, keep)`).
- Each frame, after the held hits are released (`placeShells`), a deferred
  ship whose hits are all released (the display reached the `shell_end` tick)
  is killed in that frame: hull hand-over, explosion and number together, as
  the drawn slug arrives.
- Meanwhile its new wreck's pieces get no sprite: `RenderMirror.wreckRevealFromTick`
  (the newest snapshot tick − 30 at the deferral) hides pieces of wrecks whose
  `deathTick` is on or after it until no death is held; pieces already drawn
  are never hidden. The dying-hull hold then hands over as before.
- Bounded (#16): the held hit's own safety deadline (`UNMATCHED_HOLD_MS` /
  `MAX_HOLD_MS`) and the deferral's `MAX_HOLD_MS` game-ms deadline; a welcome
  or sector handoff releases or clears them. Snapshots still say the ship is
  dead; the event only sets WHEN it is drawn dying. A death with no held hit
  (a beam, a hit already drawn) dies on arrival as before. An id recycled
  meanwhile (another kind in the entry) is not killed.
- Scope: swarm ships (AI pilots, capitals) and pilot hulls: a parked
  (lingering) hull and another pilot's ship (`deferShipKill`, keyed
  by wire id). While held, the snapshot routing keeps them though the server
  no longer lists them (`routeSnapshotShipStates` `keepLingering`,
  `syncMirror`'s departed sweep); the release kills the hull and evicts the
  parked entry and its predWorld body in that frame. The LOCAL pilot's own
  active ship still dies on the event (its death drives the spectator flip).
- **The hit tick is where the drawn shell reaches the hit** (rail take 7):
  a `shell_end` reports the tick S of the server step that swept the shell
  from its pose at S to S + 1, so at display tick S the drawn shell is still
  up to one step short (a railgun slug: ~107 u). `shellHitTick`
  (`core/combat/shellFlight.ts`) projects the hit point on the shell's line:
  the fractional tick in [S, S + 1] at which the closed-form pose is AT it.
  The burst, the pass-through burst (`ShellSalvoStore.applyEnd`), the held
  hit (`ShellSalvoStore.hitTick` → `navalHitHold.onShellEnd`) and so the
  deferred kill all wait for it. The server's side of the convention is
  locked in `ProjectilePipeline.shellEvents.test.ts` (#15).
- Rail take 7 (built with the above for swarm ships): the heavy cruiser the
  slug passed through still split ~6 frames before the drawn slug reached
  it. It was the spectating pilot's PARKED hull, not a swarm ship: its
  `destroy` went to `killEntity` at once and the next snapshot evicted it.
  `continues: 1` was not the cause (its tuple matches the held hit like a
  final one).
- **Only the killing shell holds a death** (heavy-beam take 8): a heavy beam
  killed the pilot's parked heavy cruiser, but the hull stayed whole ~0.9 s
  with the beam already through it, +260 numbers popping meanwhile. The
  battlecruiser's 5" secondaries had shells in flight to the same hull, so
  `holdsTarget` was true and the beam's kill waited for those shells (or
  `MAX_HOLD_MS`). Now the deferral and its release ask `holdsKill`: a held
  hit on that target that took its hull to 0. The server sends the lethal
  `damage` right before its `destroy` (`DamageRouter.applyInteraction`), so
  that hit is the killing blow. Second leg: the hold matches hits to shells
  by position, so a beam hit whose point lies on a live shell's path is held
  too. The beam's `laser_fired` follows its damage and destroy with `to` =
  the hit point (both sinks' `hitscan`); `DrawnShellTiming.onBeamFired`
  releases an unmatched held hit there (`NavalHitHold.releaseHitAt`) and with
  it any death held for it, in that frame.
- **A held death keeps its `vaporised`** (beam-vaporise-subcap film review):
  the heavy beam vaporised the pilot's parked missile frigate, but it just
  vanished in orange 5" smoke, with no violet flash or ash. The
  battlecruiser's 5" secondaries fire at the same hull as its beam, so the
  beam's killing hit lay on a live 5" path and was held by position (second
  leg above); the `destroy` was deferred, but `handleDestroy` had already
  put the id in the one-frame `mirror.vaporisedShips`. `laser_fired` is a
  separate message, so a render frame can fall between it and the
  `destroy`; that frame's `consumeOneFrameTriggers` cleared the set, and
  the release's explosion read as an ordinary death. Now the deferral
  record carries it (`DeferredKill.vaporised`, `deferKill(id, vaporised)`)
  and `release` re-adds the id to `vaporisedShips` in the frame it puts it
  in `explodingShips`; `handleDestroy` marks it at once only when the death
  is not held. Lock: `ColyseusClient.vaporiseDeferredKill.test.ts` (failed
  first: the four held cases, parked hull and AI ship, beam released after
  a frame and kill released by its drawn shell, saw `vaporised` false).
- Locks: `ColyseusClient.shellKillTiming.test.ts` (failed first: the hull was
  gone and the explosion queued on the destroy), `swarmSpriteUpdater.wreck.test.ts`
  "wreck pieces wait for a held death", `ColyseusClient.passThroughKill.test.ts`
  (the take's real victim and message order, snapshots through the real
  routing; failed first: the hull died on the destroy with the drawn slug
  650 u short; its "beam kill … dies at once" cases failed first: the hull
  stayed drawn after the beam's destroy), `ColyseusClient.damageAfterDeath.test.ts`
  (the number comes with the deferred explosion).

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Shells as events (slice 2a):** with the welcome's `shellEvents`, `mirror.shellSalvos` (from `net/shellSalvoStore.ts`) gives each naval shell its salvo, fire tick and origin. The warning then groups by salvo and holds one deadline per salvo, so a countdown never goes up; past it the marker reads "now" (`groupLabel`, shared with `HaloRadar`). Story: `docs/architecture/shell-events.md` "Slice 2a as built". **Slice 2b:** salvo shells are DRAWN from events: `ShellSalvoStore.place()` writes them into `mirror.projectiles` at `shellPoseAt(display tick)` as `event: true` entries, which `syncProjectiles` and the per-frame advance never touch. They burst only when the display reaches their `shell_end` (`mirror.pendingShellEnds`, one-frame queue in `perFrameTriggers`), never because they disappeared (the false edge burst). **Slice 4:** naval shells never ride `projectiles[]` any more, so `NavalShellBursts` is only the `shell_end` burster (the absence guess and `shellEndedOnHit` are deleted). **A naval hit's damage FX wait for that burst (2026-11-13):** `handleDamage` applies state at once but hands the flash / number / health-bar hit / spark to `net/navalHitHold.ts` when the hit point is on a live, unended shell's path; the matching `shell_end` (same point) gives the hit tick and `placeShells` releases it the frame the display reaches it (safety timeouts so a lost `shell_end` never swallows it). Lock: `ColyseusClient.navalHitFlash.test.ts`.
