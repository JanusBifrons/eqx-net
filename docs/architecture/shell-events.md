# Shells as events (design note)

Status: **slices 0 and 1 built** (server emits events behind `EQX_SHELL_EVENTS=1`; the client doesn't consume them yet). See "Slice 1 as built" at the end. Handoff 2026-11-10, Next #3: "Shells as events (spawn/land on the wire). This fixes the false burst at the edge of the view and the incoming-fire countdown estimate, and it's needed before big fleets."

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
  ])).min(1).max(256),
}).strict();
```

A miss sends nothing: the client knows `t + n` and ends the shell there silently, which is the rule already (misses end with no burst). A shell stopped by a shield fence is a hit with radius 0 at the wall. Damage numbers keep their own `DamageEvent`.

**Size.** A 9-shell salvo is ~60 B of header + ~45 B per shell ≈ 470 B, once. Each hit is ~35 B.

## 3. Who receives it

A viewer gets a salvo if any of these holds, decided per shell, at fire time:

1. **The flight crosses the viewer's view.** The segment origin → fall point meets the square of half-extent `shellViewHalfExtent(viewer kind)` (a new shared `shellSegmentInView`, slab test, alloc-free). This replaces today's "shell or fall point in view", which misses a shell that crosses the view mid-path.
2. **The viewer fired it, or is its target** (`g` is the viewer's ship).
3. **The owner is a wide entity in the viewer's interest** (today's rule, so a capital's broadside is seen leaving the barrels).

The viewer moves during a 35 s flight, so the server keeps, per recipient, a stamp of which live shells it has sent (generation counter on a pooled per-client slot, #14). On the 1 Hz keyframe tick (§5) it re-tests unsent live shells against the viewer's current pose and sends any that now qualify as a `shell_salvo` holding just those shells. `shell_end` goes to every recipient whose stamp says it has the shell.

When the flag is on, naval shells leave the per-tick `projectiles[]` loop for event-capable clients (the `NAVAL_SHELL_IDS` branch skips them). Sub-capital bolts are unchanged: their flights are short and the ±3,072 u box already bounds them.

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

Behind `EQX_SHELL_EVENTS=1` (per process, read once, like `EQX_NAVAL_RANGE`). The server stamps it on the welcome; the client consumes events only when its welcome says so, so the two sides can't disagree (#15) and no page flag is needed. Each slice is one PR (~10–20 min agent).

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

- **Drawing:** each frame `ColyseusClient` computes the display tick (`clockAnchorServerTick + (now − clockAnchorPerfNow) / tick − DISPLAY_DELAY_MS / tick`, the timeline drones and remote ships are drawn on) and `ShellSalvoStore.place()` puts every live salvo shell into `mirror.projectiles` at `shellPoseAt(displayTick)`, flagged `event: true`, from its fire tick to `shellPathEndTick`. `syncProjectiles` neither overwrites nor deletes `event` entries, and the per-frame advance skips them. The per-tick `projectiles[]` copy (same id) is ignored once a shell is event-drawn; slice 3 stops sending it.
- **Hits:** `shell_end` only marks a shell (tick and point). When the display tick reaches the hit, `place()` queues `[x, y, shellRadius]` into `mirror.pendingShellEnds` (one-frame queue, `consumeOneFrameTriggers`) and removes the shell, so the burst lands where the drawn shell is. An end for a shell never seen bursts at once. A miss is removed silently past `shellPathEndTick`.
- **No false edge burst:** `NavalShellBursts` never bursts an `event` shell because it disappeared (it may only have left the viewer's interest). A shell this viewer got only per tick keeps the old guess until slice 3.
- **Locks:** `navalShellBursts.test.ts` ("a shell drawn from events that leaves the view at half travel does not burst", which failed first as a burst at (3000, 0)), `shellSalvoStore.test.ts` (closed-form pose at the display tick, nothing before the fire tick, hit bursts on the display clock, miss removed silently, snapshot sync leaves event shells alone).

## Slice 3 as built (2026-11-12): naval shells leave `projectiles[]`

- With the room's hub on (`EQX_SHELL_EVENTS=1` or the testMode `shellEvents` option), every client's welcome says `shellEvents`, so `SnapshotBroadcaster` skips every naval shell in the per-tick `projectiles[]` loop (one check per recipient). Sub-capital bolts are unchanged. The shells reach a viewer only by the hub's rules (§3): salvo, 1 Hz re-test, join backlog, keyframe.
- **Locks:** `SnapshotBroadcaster.navalShells.test.ts` ("events on: the 16\" shell is not in projectiles[]; a bolt in the box still is", failing first; "events off: unchanged"); `tests/integration/sectorRoom/shellEvents.test.ts` (no naval shell rides a snapshot in an events room).
- **Measured (2026-11-12, `naval-broadside` perf scene).** Ten hostile battleships fire on a battleship pilot 15 km off at real range. NPC capital turrets engage pilots and structures, never other NPCs, and a main gun never locks a fighter, hence the capital pilot. Same commit, `--base-env EQX_NAVAL_RANGE=real` vs `--head-env "EQX_NAVAL_RANGE=real&EQX_SHELL_EVENTS=1"`, 4 reps per arm on the laptop: **GREEN, rx 254 → 67 KB/s per pilot (×0.26, p = 0.03)**. Entities per JSON snapshot went 100 → 1; frame p95, render p95 and server tick p95 are unchanged. The command is in `perf-scenes.md`. Slice 4 (default on, delete `navalShellInView`'s fall-point rule and the absence guess) follows it.
