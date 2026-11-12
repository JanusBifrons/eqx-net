# Game speed

Each sector of the galaxy runs at its own **game speed**, normally 1×.

**What changes the speed:**
- **Under load (planned, stream Phase 5):** a busy sector slows itself a little, rather than stuttering.
- **Demos, videos and tests:** a sector can be set faster or slower deliberately, from 0.25× to 4×.

## What the player sees

- **Everything in the sector moves together.** Ships, shots, drones, timers, reloads, spools, explosions, beams and shields all run at the sector's speed, so slow motion looks like slow motion and not like lag.
- **A small chip in the status capsule** (top centre, beside energy and credits) shows the speed while it isn't 1×. It is amber for slower ("the server is busy, not your connection") and cyan for faster. At 1× there is no chip.
- **The interface keeps real time.** Menus, the camera, the warp curtain and lock marks don't slow down.

## Setting it (dev, tests, video)

- **URL** (test rooms): `?timeScale=2` sets the sector's speed when you join.
- **Dev endpoint:** `POST /dev/time-scale?room=<roomId or sectorKey>&scale=0.5`. `GET /dev/time-scale` lists every sector's speed.
- **Boot default:** `EQX_TIME_SCALE=0.5` sets every sector's starting speed (not in production).

How it works: [docs/architecture/game-time-scale.md](../architecture/game-time-scale.md).
