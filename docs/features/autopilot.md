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
- **Setting a course:** tap empty space (every hull). WASD or the stick cancels it. A capital always shows the helm panel; a smaller hull shows it only while a course is set.
- **Flying the route:** the helm steers at each turn in order and moves on to the next one as soon as it is within its turn lead (`helmPassRadius`: about how far the ship travels while it comes round), so it sweeps through bends rather than stopping at each. Only the last leg brakes and arrives; arrival is within the hull's own size (`helmArriveRadius`).
- **Reply lost or late:** a reply older than the current course is ignored; one that never comes is asked for again after 5 s, and the ship flies straight at the point meanwhile.

## Status

- Slice 12 (2026-11-18): the request and reply on the wire, served by the room.
- Slice 13 (2026-11-18): the helm flies the route on every hull (`core/helm/helm.ts` route + pass radius; `client/helm/helmRoute.ts` asks and loads the reply). Locks: `helm.test.ts`, `helmRoute.test.ts`, e2e `autopilot-round-rock.spec.ts` (a fighter flies round a field rock to the far side). The route line on screen follows (slice 14).
- Internals: [navigation](../architecture/navigation.md#the-players-autopilot-asks-servernavautopilotroutests).
