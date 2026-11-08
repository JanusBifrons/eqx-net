# Weapon groups and target locking (Fire Control HUD)

Status: experimental, behind `?ui=d` on branch `exp/fire-control`. Players on the
legacy HUD and on `?ui=a|b|c` play exactly as before.

## The idea

There is no manual fire. Every **weapon group** fires only at a target it has
**locked**, and every NPC has to lock you before it can shoot you. Locking is a
short, visible commitment that both sides can see building.

A ship's weapon slots are its groups (gunship: **Fore** and **Aft**; missile
frigate: **Missiles** and **PD**; crossguard: **Port** and **Starboard**;
capitals: **Main**, **Sec** and **AA**). Activated latent mounts form a **Wing**
group. Each group has its own colour, used on its chip, its target brackets and
its firing line, so you can see what's shooting what.

## Locking

**Lock time** is worked out on the server from the shooter's sensors and the
weapon's tracking against the target's size, crossing speed and range
(`lockSeconds`, tuning in `shared-types/combat/lockProfile.ts`). A matched pair
takes about 1.5 s. Big guns barely track a small, fast ship, so a battleship's
main guns effectively can't lock a fighter; its AA can.

There are two ways to lock:

1. **The lock line (manual).** Drag your right thumb (touch) or hold the left
   mouse button (desktop). A dashed line leaves your ship and the target nearest
   it gets a white ring. **Keep the line on the target** and the active group's
   lock builds. Slide off it, or let go before it finishes, and the lock
   **drains back to 0** ("LOSING LOCK") and drops. Bring the line back before it
   empties and it carries on. Once it reads LOCKED you can let go.
2. **Hands-off.** Tap a ship to open its info box and press **LOCK · FORE** (the
   active group). It locks on its own; the button becomes **CANCEL LOCK** while
   it runs and **UNLOCK** once locked.

**AUTO groups** pick their own hostile target, only from targets inside the
group's arc (a rear turret never takes a ship dead ahead). **MAN groups** never
pick for themselves; hold the group's chip to fire it.

**Neutrals and allies** can be locked too, but a yellow **failsafe** ring runs
first (1.75× as long). Let go of it and nothing happens. Finish it and you have
committed a hostile act; the normal red lock then runs.

## Firing

A group fires at its LOCKED target when it is AUTO (or its chip is held in MAN)
**and a barrel of the group actually points at the target**. A turret that can't
turn far enough (the target is outside its arc) never fires. Fixed guns need the
nose on the target.

## Being locked

- **Top band:** "⚠ FIGHTER ×2 HAVE YOU LOCKED" (flashing) and
  "+ Heavy LOCKING ON YOU 60%". Names come from the ship kind, never an id.
- **On your ship:** a red arc on a ring around you, facing each ship that is
  locking you, narrowing as its lock builds. Once it has you, a solid red caret
  points at it and the ship gets a pulsing red diamond.

## Controls

| | Touch (landscape) | Desktop |
|---|---|---|
| Move | Left thumb floating stick | WASD |
| Lock (manual) | Right thumb: hold the lock line on a ship | Hold LMB on a ship |
| Lock (hands-off) | Tap ship → LOCK | Click ship → LOCK, or **T** |
| Pick group | Tap its chip | **1–9** |
| AUTO / MAN | The chip's pill | **Shift + 1–9** |
| Fire a MAN group | Hold its chip | Hold its chip |
| Drop a group's locks | × beside the chip | **X** |
| Boost | BOOST | RMB |

## Try it

`/?room=fc-duel&startHostile=1&shipKind=gunship&ui=d` is a 1v3: two fighters and a
heavy wait ahead. Drop `startHostile=1` and use `room=feel-test` to try the
failsafe on neutral drones.

Internals: [docs/architecture/fire-control.md](../architecture/fire-control.md).
