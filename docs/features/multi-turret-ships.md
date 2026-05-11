# Multi-Turret Ships

Shipped 2026-05-11 as the multi-mount/turret refactor (Phases 0–4c). Two new ship kinds, visible rotating turrets, auto-aim AI on every weapon, on both player and drone ships.

## What's new in the cockpit

### Ship kinds

The 1-key, 2-key, and 3-key picker now offers **five** ships:

| Key | Kind | Mounts | Arc | Slew | Hull |
|---|---|---|---|---|---|
| 1 | Fighter | 1 forward | fixed | — | 100 |
| 2 | Scout | 1 forward | fixed | — | 60 |
| 3 | Heavy | 1 forward | fixed | — | 180 |
| 4 | **Interceptor** | 2 wings | ±30° each | 4 rad/s | 80 |
| 5 | **Gunship** | 1 forward + 1 rear | ±45° / ±90° | 3 rad/s | 140 |

The **Interceptor** fires two wing-mounted beams in parallel that auto-track the nearest hostile drone within their arcs. Higher damage per cooldown than a fighter; less hull.

The **Gunship** fires forward AND backward simultaneously. The rear turret has a 180°-wide arc so it can engage a drone tailing you while you keep flying forward. Slower to turn and slower to slew, but tankier than a fighter and harder to flank.

The legacy fighter/scout/heavy are unchanged — single fixed forward beam, no rotation, identical feel to pre-refactor combat.

### Turret behaviour

For both player ships and drones:

- **Targets auto-acquire** at hitscan range (500 u). Outside that range, mounts slew smoothly back to forward and stay there until something enters range.
- **Sticky targeting**. Once a turret has locked a target, it keeps that target unless something else becomes meaningfully closer (within 10 % of the current target's distance). Suppresses oscillation between near-equidistant drones.
- **One target per slot**. All mounts in the same logical slot converge on the same target — the gunship's forward and rear turrets aim at the same drone, even though only one can hit at a time. Pressing Space fires every mount in the active slot whether or not it can reach the target (intentional miss when out of arc — the player chose to fire).
- **Visible aim line**. Every mount projects a faint dotted line out to weapon range showing where it'll fire. The line sweeps in real time as the turret tracks. Use it for line-of-sight checks.

### What firing looks like

- **Single-mount ships**: identical to before. One beam, one cooldown, one fire-flash.
- **Interceptor**: two beams emerge simultaneously from the wing tips, each at its own slewed angle. If one wing can't reach the target (target is past arc limit), that wing fires at its arc limit — visible miss.
- **Gunship**: forward beam AND rear beam emerge simultaneously. The rear beam emerges *backward* from the tail — looks dramatic the first time you see it. Useful when you're being chased and your body can't (or shouldn't) turn around.

### Drone behaviour

AI drones spawn at random ship kinds. After Phase 4c, drone interceptors and gunships behave like the player versions:

- Wing/rear turrets visibly track you within their arcs.
- Beams emerge from rotated barrel directions, not just the body's forward.
- A gunship drone can engage you with its rear gun while its body is fleeing — a meaningful threat that wasn't possible pre-4c.
- The drone AI's fire gate widens with mount arc, so a drone fires even when its body is off-aim by more than 14° as long as a turret could reach. Drone gunships fire on targets up to ±104° from body forward.

## How aim assist changes the gameplay

Pre-refactor combat required you to align your ship's nose with the target. After Phase 4b.3 + 4c:

- **You drive, the turrets aim.** With an interceptor your effective fire arc is now 60° wide (the wing arcs combined). With a gunship the rear turret gives you a 180° rear cone — you can fight while running.
- **The "where will my shot go" question is answered visually.** Watch the dotted aim lines; they show the exact direction every mount will fire when you press Space.
- **Server-authoritative aim**. The visible turret rotation is what the server sees too. Aim assist actually changes which drones you hit — it's not just a visual.
- **Out-of-arc targets are still misses.** A drone behind your interceptor (wings only point forward ±30°) can't be hit until you turn. A drone directly in front of the gunship's rear mount is similarly unreachable. The mounts tell you their limits via the dotted line clamping at arc edges.

## Engineering room — `mount-test`

If you want to test multi-mount behaviour without waiting for random drone spawns, join via:

```
http://localhost:5173/?room=mount-test
```

(Or substitute your LAN address for mobile testing.) The room spawns **3 interceptors + 3 gunships** in a 250 u ring at origin every time, no asteroids, no random filler. Drones spawn IDLE; fire any weapon at one to mark it hostile and trigger combat — its turrets will start tracking you, and the gunships will start engaging from any direction.

## Known limitations / deferred work

- **Mount-angle lag-comp ring buffer**. The server currently uses the *current* mount angle for hit-test rays rather than the angle at the fire-tick. Error is bounded by RTT × rotationSpeed (~0.2 rad at 50 ms RTT × 4 rad/s on the interceptor — well inside the aim tolerance). Not visible in normal play; would matter for sub-degree-accuracy sniping at high latency.
- **Aim arc indicator** (the faint wedge showing each mount's full rotation range). Considered for Phase 4b but the rotating turret + dotted aim line already conveyed arc visually; can be re-instated if telemetry shows new players struggle to read each kind's mount capability.
- **Per-mount weapon swapping**. The catalogue stores `weaponId` per mount as data, so a future loadout UI could let you swap (e.g. put a slow heavy gun on the gunship rear). Not exposed in the UI today.
- **PvP-aware hostility**. Player turret AI currently treats all drones as hostile and ignores other players (there's no PvP yet). Adding faction-aware targeting is a one-line predicate change in the player slot's `pickTarget` call.

See [docs/architecture/weapon-mounts.md](../architecture/weapon-mounts.md) for the technical writeup.
