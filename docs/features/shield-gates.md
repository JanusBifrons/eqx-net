# Shield Gates and Airlocks (player-facing)

A shield fence keeps everything out — including you. **Gates** are the doors in
a fence: solid sliding doors that open for the ships they let in and close
behind them.

## The two gate kinds

**Shield Gate** (320 × 72). Two towers placed together as one structure, with a
pair of solid doors across the gap between them. When a ship the gate admits
comes within about 300 u of either side, the two halves slide apart into the
towers; once nobody is near, they slide shut again after about a second. A
closing door does not wait for you: it pushes a ship still in the gap back out.

**Shield Airlock** (320 × 260). A chamber with solid side walls and a pair of
sliding doors at each end. It opens **one end or the other, never both**:

1. You arrive at end A — end A opens.
2. You fly into the chamber — end A closes behind you.
3. End B opens — you fly out, and it closes behind you.

An end only starts to open once the other end is fully shut. Ships coming from
the other side get the same in reverse. Use an airlock where a
plain gate would let an attacker slip in behind a friendly ship.

## Who a gate opens for

Each gate has its own setting. Select one of your gates and use the lock button
in the inspector to cycle it:

| Setting | Opens for |
|---|---|
| **Owner + allies** (default) | you, and anyone allied with you |
| **Owner only** | you |
| **Anyone not hostile** | every ship that isn't hostile to you |

The inspector shows the current setting (**OPENS FOR …**) to everyone, so other
pilots can see whether a gate will open for them. Alliances arrive in a later
update; until then "owner + allies" behaves like "owner only".

## Building gates into a fence

A gate joins a fence the same way a pylon does: connect it to the pylons on
either side and to one connector. The fence walls run right up to the gate's
posts, so the barrier stays continuous up to the door. Rotate a gate (**R**
while placing) so it lies along the fence line.

## Doors and power

- **Speed.** At full power a door takes **3 seconds** to open or close. On a
  grid short of power the doors move more slowly (half power, half speed).
- **No power.** The doors stop where they are: an open gate stays open, a shut
  gate stays shut, and a half-open gate stays half open (the gap is real, so a
  small ship may still fit through).
- **Power use.** A gate only draws its full power (gate 30, airlock 50) while
  its doors are moving; standing still it uses a small trickle.
- **Lights.** The deck lights on each end show the door: **green** only when it
  is fully open, **red** when it is shut or moving, **dark** when it has no power.
- **Gunfire.** Shut doors are solid: shots hit them and damage the gate. Shots
  pass through an open gap. Stunning the fence does not open a gate; to break
  in, destroy the gate.

## How it works

The gate's towers and its door leaves are solid bodies. The server decides when
a door should open or shut and sends only where the door started, which way it
is moving and how fast; the server and your client both work out where the
door is from that one record, so your ship never snaps back at an open gate or
slips through a closed one. Architecture:
[structures-and-power-grid.md](../architecture/structures-and-power-grid.md#gates).
