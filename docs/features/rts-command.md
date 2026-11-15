# Commanding your fleet (Command view)

Every ship you own is part of your fleet. When you are not flying one of them
yourself, they fly themselves, and you give them orders from above, like a
real-time strategy game. This page describes what the player sees and does.
For how it works inside, see
[docs/architecture/fleet-command.md](../architecture/fleet-command.md).

## You start in Command view

Joining a galaxy sector puts you in **Command view**: a free camera over the
sector, every one of your ships parked and flown by its own AI wingman. The
indicator at the top reads "Command view". (Test rooms and the "Pilot that
ship" button on the galaxy map still drop you straight into the cockpit.)

Two buttons switch between the views:

- **Command**: leave the ship you are flying. It parks where it is and its
  wingman takes over, guarding that spot.
- **Fly**: with exactly one of your ships selected, take its controls. With
  nothing selected, a short menu of your ships opens; pick one.

You can also **double-click (double-tap)** one of your parked ships to take
its controls. If the ship you fly is destroyed, you drop back to Command view.

## Moving the camera

- **Desktop:** WASD or the arrow keys pan, the mouse wheel zooms, and dragging
  with the **middle** mouse button pans. A left drag draws a selection box, not
  a pan.
- **Phone:** drag with one finger to pan, pinch to zoom.

## Selecting ships

- **Click (tap) one of your ships** to select it. If it belongs to a squad, the
  whole squad is selected; click a member again to narrow down to that ship.
- **Shift-click** adds a ship (or its squad) to the selection, or removes a
  ship that is already selected.
- **Drag a box** with the left mouse button to select every ship of yours
  inside it (and the rest of any squad it touches). On a phone, **hold your
  finger still for half a second** until the ring grows under it, then drag.
- Click empty space to clear the selection.

Selected ships show a ring, and a line to where each is going: its move point,
its target, the ship it escorts, or its patrol loop.

## Giving orders

- **Right-click empty space:** the selection flies there and holds. Several
  ships sent to one point each take their own spot in a tight cluster round
  it, keeping their side of the group, so they don't pile onto each other.
- **Right-click an enemy:** the selection attacks it.
- **H** (or the **Stop** button): each ship brakes at once, as hard as its
  engines allow, and holds the spot where it comes to rest.

On a phone, with ships selected, a tap gives the order. The **Move / Attack**
toggle on the fleet strip says which: Move sends them to the tapped point,
Attack sends them after whatever you tapped.

## The fleet panel

While ships are selected, the fleet panel replaces the build bar at the bottom
of the screen (a slimmer fleet strip on a phone). It lists each ship by type,
its hull, and what it is doing in plain words: Idle, Moving, Patrolling,
Chasing a Drone, Attacking, Guarding, Forming up, or Retreating with its hull
percentage.

### Modes: what a ship does when it has no order

| Mode | What the ship does |
|---|---|
| **Defend** | Guards its spot and fights anything hostile that comes close. The default. |
| **Patrol** | Flies a loop through points you pick on the map. |
| **Escort** | Stays beside another of your ships (or the one you fly) and defends it. |
| **Hunt** | Goes after the nearest hostile it can sense, and guards its spot when there is none. |
| **Retreat** | Flies to a point you pick (or back to its post) without fighting, then defends there. |

Patrol, Escort and Retreat ask you to pick on the map first: the panel shows a
short hint and **Done / Cancel** buttons. For a patrol, click two or more
points, then Done (or Enter, or a right-click). For an escort, click the ship
to escort. For a retreat, click the point, or press **Back to post**. Escape
cancels.

An order (move, attack, stop) is a one-off on top of the mode. When the order
is done, the ship goes back to its mode from where it is now.

### Stances: when a ship opens fire

- **Aggressive:** attacks any hostile in weapon reach.
- **Defensive:** fires at what it was ordered to attack, at whoever shot it or
  its squad, and at hostiles close to its spot. The default.
- **Hold fire:** never fires.

Your ships never shoot other players unless you order the attack or a player
shot them first.

### Squads

Select two or more ships and press **Form squad**. They fly in formation on
the squad leader, and a click on any member selects the whole squad. An order
to the whole squad goes to the leader and the rest keep formation. If you fly
a squad member yourself, you lead the squad and the others form up on you.
**Disband squad** breaks it up.

### Morale

A ship that is losing badly may lose its nerve: it breaks off and falls back,
or flees, then returns to its mode once it is safe. A new order from you
calls it back at once.

## Phone controls in short

| Do this | To |
|---|---|
| Tap your ship | Select it (or its squad) |
| Hold still, then drag | Draw a selection box |
| Tap with ships selected | Order: move there, or attack it (Move / Attack toggle) |
| One-finger drag / pinch | Pan / zoom |
| Double-tap your ship | Take its controls |

## Known limits

- A ship flying fast takes a few seconds to brake to a stop (it has only its
  own engines, like a pilot).
- Fleet orders are for ships in the sector you are in.
