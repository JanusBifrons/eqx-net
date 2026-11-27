# Sandbox room

<!-- showcase-exempt: a play-test room, not a player-facing feature of the game world -->

A room for trying things out: build a base for free and fly any hull. Open it
with `?room=sandbox` (on the phone lane: the lane link plus `&room=sandbox`).
Sign in first ("Sign in as me" on the lane) so the ships are yours.

## What you get

- **Free building at normal build time.** Every player build and upgrade
  costs nothing (no crate, no minerals) but takes its normal time, so the
  pace still feels real. A free structure taken down gives nothing back.
  The build menu shows every kind unlocked (`state.freeBuilds`).
- **A ship yard.** On joining, one of every base player hull (no capital fit
  variants) waits parked in a grid near the spawn, owned by you. Take any of
  them over. Re-joining resumes your sandbox ship and refills missing hulls;
  it never duplicates them.
- **A deck room** with no asteroids, no hostile drones and no NPC bases.

## Sealed: nothing leaves

The sandbox is a *sealed* sector (`src/server/rooms/sealedSectors.ts`,
`isSealedSectorKey`). One predicate keeps it apart from the real game:

- **Roster** (`rooms/rosterSealing.ts`): a sandbox join never takes your real
  ship, and a real join never takes a sandbox ship. Sandbox ships are hidden
  from the real Hangar list. No starter grant is spent there.
- **Exits** (`crossesSeal`): no warp, fleet warp or teleport into or out of
  the sandbox; its teleporters never pair with real ones.
- **Credits** (`paysRealCredits`): no station taxes, bounties, dock trading,
  blueprint buying or selling, or tolls; launches there are free.
- **Battle rooms are sealed too** (`?room=battle-*`, [battle-scenarios](battle-scenarios.md)): same rules, and each run also clears its own rows when it opens.
- **Wiped on restart.** The sector is never saved, and every sandbox roster
  row and its holds are purged at boot (`persistenceBoot`), whether or not
  the sandbox is enabled.

## How it is wired

- `src/server/rooms/testRooms/sandboxRoom.ts`: `SANDBOX_OPTS` and
  `SandboxRoom`, which ignores client create options (they would otherwise
  reach `onCreate`) and allows one instance only. Created eagerly at boot.
- Registered when test rooms are on, or with `EQX_ENABLE_SANDBOX_ROOM=1`
  (`shouldRegisterSandboxRoom`). The phone lane sets it; other test rooms stay
  off there.
- It is **not** a testMode room: the test-only join options and `test_*`
  messages stay off for anyone with the link. `deck` and `persistSector` are
  honoured for sealed rooms as well as testMode ones.
