# Collision Events — Server-Authoritative Velocity Push

Stage 2 of the network-feel roadmap. The server's physics worker drains Rapier's `EventQueue` after every step, filters by impulse magnitude, and broadcasts post-collision velocities to clients the instant the contact resolves — eliminating the cascade of 6–10 drift corrections that pre-Stage-2 clients would replay over ~400 ms after every meaningful contact.

## The problem this fixes

The 2026-05-08 user diagnostic (`docs/LESSONS.md` Pattern A) captured a single ship-vs-drone collision producing this cascade:

```
t=28588  COLLISION         drift=19.97u
t=28614  recovering        drift=10.04u
t=28689  RE-DIVERGED       drift=19.90u
t=28716  recovering        drift=10.02u
t=28788  RE-DIVERGED       drift=20.12u
t=28821  STILL diverging   drift=20.26u
t=28888  recovering        drift=10.22u
t=28919  recovering        drift=10.17u
t=28944  recovering        drift=10.18u
```

8 corrections over 410 ms. Cause: the client kept integrating its `predWorld` forward at the *pre-collision* velocity for ~50 ms after each snapshot — by the time the next snapshot arrived showing the post-collision velocity, the client had drifted *another* 20 u. Re-derivation of post-collision velocity through snapshot replay took ~6 cycles to converge.

The fix is: skip the snapshot-replay re-derivation. When the server's physics worker resolves a collision, broadcast `vPost` to clients directly as a discrete message; the client patches predWorld immediately and the cascade collapses to a single correction.

## The four-hop relay

```
┌─────────────┐  EventQueue.drainContactForceEvents
│  Worker     │  filter(forceMag >= CONTACT_FORCE_FLOOR)
│ (Rapier)    │
└──────┬──────┘
       │ postMessage('CONTACT_BATCH', { tick, contacts: [...] })
       ▼
┌─────────────┐  emit Bus 'COLLISION_RESOLVED'
│  Main       │
│ (SectorRoom)│
└──────┬──────┘
       │ broadcast('collision_resolved', { aId, bId, vA, vB, impulse, tick })
       ▼
┌─────────────┐  zod parse (defensive)
│  Client     │  applyCollisionResolved
│ (Colyseus)  │  predWorld.setShipState(id, { ...cur, vx, vy })
└─────────────┘
```

Each hop is a deliberately thin contract:

| Hop | Contract | Source |
|---|---|---|
| Worker → Main | `{ type: 'CONTACT_BATCH'; tick: number; contacts: Contact[] }` (one batch per tick when non-empty) | [`src/core/physics/worker.ts`](../../src/core/physics/worker.ts) |
| Bus emit | `COLLISION_RESOLVED` discriminated-union variant | [`src/core/events/Bus.ts`](../../src/core/events/Bus.ts) |
| Server → Client | `room.broadcast('collision_resolved', payload)` | [`src/server/rooms/SectorRoom.ts`](../../src/server/rooms/SectorRoom.ts) |
| Schema | `CollisionResolvedMessageSchema` (zod, strict) | [`src/shared-types/messages.ts`](../../src/shared-types/messages.ts) |
| Client handler | `applyCollisionResolved(msg, predWorld, guard, nowMs)` | [`src/client/net/applyCollisionResolved.ts`](../../src/client/net/applyCollisionResolved.ts) |

## Force floor

The worker applies a 200 N force floor (`CONTACT_FORCE_FLOOR`) before broadcasting. At a 60 Hz step that's ~3.3 N·s impulse. This catches every meaningful ship-vs-asteroid / ship-vs-drone collision but filters out drone-drone soft touches and minor jostling at rest. Tunable in one place if user testing reports either over- or under-reporting.

The collider's engine-level `setContactForceEventThreshold(10)` is a coarser pre-filter — it suppresses the noisiest events at the C++ Rapier layer before they hit the JS event queue, but the meaningful gate is the worker's force floor.

## Client-side guards

Two guards live in `applyCollisionResolved`:

1. **Stale-event guard.** `tick < guard.lastSnapshotServerTick` — drop. The latest snapshot has already corrected predWorld through reconciliation; a late collision event would un-correct it. Snapshots win.
2. **Rate limit.** Per-ship sliding window of 4 events per 1 s. Rapier emits one contact-force event per step that a contact remains active above the threshold; a sustained grinding contact would generate 60 events/s. The worker's force floor suppresses most of this; the rate limit is belt-and-braces.

Both guards are unit-tested by the 8 fuzz cases in [`applyCollisionResolved.test.ts`](../../src/client/net/applyCollisionResolved.test.ts).

## What this does *not* do

- **No AOI filter on broadcast.** `room.broadcast('collision_resolved', ...)` reaches every client in the room. Per-tick contact volume is naturally bounded (a few contacts above 200 N per second under typical play), and the client's `applyCollisionResolved` silently no-ops on bodies its predWorld doesn't track — so a remote-only drone collision is filtered at the receiving end with a `Map.has` check. Revisit if a future profile shows broadcast-bandwidth becomes meaningful in dense rooms.
- **No swarm-body application.** Asteroids and drones aren't in the client's predWorld — they live in the binary swarm channel which delivers a fresh authoritative pose every 60 Hz tick. The client's guard naturally skips them; only ships (which *are* in predWorld) receive the velocity patch. Ship-vs-drone events only update the ship; the drone's post-collision velocity comes through the swarm channel as usual.
- **No collision-prediction on the client.** The client doesn't anticipate collisions before the server resolves them; it just believes the server's `vPost` the moment it arrives. (A collision-prediction extension would belong in Stage 3 — remote-entity forward prediction — not here.)

## Telemetry

`PredictionStats.collisionEventsApplied` is incremented every time `applyCollisionResolved` actually mutates predWorld. The Tier-2 spec [`tests/e2e/collision-events.spec.ts`](../../tests/e2e/collision-events.spec.ts) drives into the drone ring and asserts the counter is > 0 — confirming the production path is wired.

To observe the cascade-collapse property in user testing, look at successive 'correction' log entries in the eqxLogs ring buffer: the pre-Stage-2 pattern was 6–10 correction-cluster bursts within 100–200 ms; Stage 2 reduces this to 1–2 corrections per physical contact.
