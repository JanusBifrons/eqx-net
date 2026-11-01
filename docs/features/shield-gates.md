# Shield Gates and Airlocks (player-facing)

A shield fence keeps everything out — including you. **Gates** are the doors in
a fence: a shield that opens for the ships it lets in and closes behind them.

## The two gate kinds

**Shield Gate** (320 × 72). Two posts placed together as one structure, with a
shield across the gap between them. When a ship the gate admits comes within
about 300 u of either side, the shield drops; once nobody is near, it closes
again after about a second. It never closes on a ship that is still in the gap.

**Shield Airlock** (320 × 260). A chamber with solid side walls and a shield at
each end. It opens **one end or the other, never both**:

1. You arrive at end A — end A opens.
2. You fly into the chamber — end A closes behind you.
3. End B opens — you fly out, and it closes behind you.

Ships coming from the other side get the same in reverse. Use an airlock where a
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

Gates draw power like pylons (gate 30, airlock 50). Their shield follows the
same rules as the fence: an unpowered gate has no shield at all (so it lets
everyone through, like an unpowered fence), and heavy fire on a closed gate
drains your batteries and can stun it.

## How it works

The gate's posts are solid; its shield is a separate wall that the server
switches off while that end is open. Both the server and your client build the
same posts, spans and fence walls from the same shared geometry, so your ship
never snaps back at an open gate or slips through a closed one. Architecture:
[structures-and-power-grid.md](../architecture/structures-and-power-grid.md#gates).
