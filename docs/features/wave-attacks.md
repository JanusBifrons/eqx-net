# Wave Attacks — drone squads vs your base

> Status: shipped 2026-06-10. Plan:
> `.claude/plans/i-d-like-you-to-resilient-hellman.md`. Supersedes the
> occupancy-driven "hunters converge on any player" Living World behaviour.

## The loop

Build a base → start extracting → get attacked in waves → defend.

1. **Build.** Place a Capital (core), a Miner, a Solar (power), and a Turret
   (defence). While your base is incomplete you are left alone — a player with
   no base roams an unhunted galaxy.
2. **Trigger.** Once your base has **a constructed Capital + ≥1 Miner + ≥1 Solar
   + ≥1 Turret**, the director marks your base a wave target.
3. **Warning.** A drone squad spools to warp into your sector. Every player in
   the sector sees a HUD countdown banner — **"8 × Legionnaires warping in — Ns"**
   — for the full ~5-minute spool. (All warps now take 5 minutes to spool; your
   ship is damageable the whole time, so changing sectors mid-siege is risky.)
4. **Attack.** The squad warps in **together** and attacks, prioritising your
   **structures** over your ship (the Capital and Miners first). Your turrets
   fire back automatically.
5. **De-escalation.** The wave stops when **all your Miners are destroyed AND
   you've dealt no damage to a drone for a while** (a peaceful timeout). The
   squad stands down and retreats. Rebuild a Miner (or shoot a drone) and the
   waves resume.

## Factions & hostility

You + the structures you own (in a sector) are one **faction**. If you OR any of
your structures (e.g. a turret) damages a drone, the **whole faction** becomes
hostile to the drones — they'll engage your base, not just the structure that
shot them. Incoming drones tasked against your base show **red on your radar**
before they reach you.

## Squads

Drones roam in **squads of 8** with one strategic brain: they warp together, go
hostile together, and retreat together, but each drone flies and picks targets
independently. v1 squads are homogeneous "Legionnaires" (a flavour codename for
the fighter hull); difficulty, squad count, intervals, and mixed-kind squads are
all tunable later via the `WavePattern` strategy.

## Architecture

See [docs/architecture/living-world.md](../architecture/living-world.md) for the
director internals (the `WaveDirector` / `SquadPool` / `SquadBehaviour` /
`WavePattern` composition and the per-room `FactionLedger`).

## Ops

`EQX_DISABLE_LIVING_WORLD=1` disables all director-owned drones (no waves), for
peaceful building/playtests. Ambient per-sector patrol drones remain but stay
neutral until shot. `EQX_BOT_SPOOL_MS` overrides the drone-squad spool (E2E /
tuning); the player spool is overridable per-room via the testMode
`transitSpoolMsOverride` join option.
