# Autopilot

The autopilot flies your ship to a point you pick and takes it round rock on the way, the same way AI-flown ships find their way through an asteroid field. It works for every hull: a fighter threads between rocks, a capital keeps to the wide lanes it can actually turn in.

## How it works

- **You pick the point; the server finds the way.** Your client asks the server for a route from your ship to the point. The server plans it for your own hull (its size, and for a capital its heading and turning circle) on the same navigation maps the AI pilots use, and answers with the turns to fly.
- **Your ship flies it with your controls.** The route is advice, not a new kind of movement: your client's helm turns it into ordinary thrust and turn inputs, exactly as the capital helm already does. Nothing new for the server to correct (from navigation slice 13).
- **Wide lanes first.** Routes favour wide space; narrow streets carry a high cost, so they are taken only when they save a lot (owner, 2026-11-17).
- **No way through?** You are taken as close as your ship can get, and it waits there.
- **Capitals commit.** A capital that enters a lane goes on to its far end: no route turns it round inside a lane, where it has no room to turn.
- **Open space** (a sector with no asteroid field) answers "fly straight" at once.

## Limits

- One route request at a time per player, and at most two a second; extra requests are ignored, and the client simply asks again.

## Status

- Slice 12 (2026-11-18): the request and reply on the wire, served by the room. The helm flying it (slice 13) and the route line on screen (slice 14) follow.
- Internals: [navigation](../architecture/navigation.md#the-players-autopilot-asks-servernavautopilotroutests).
