# Autopilot

The autopilot flies your ship to a point you pick and takes it round rock on the way, the same way AI-flown ships find their way through an asteroid field. It works for every hull: a fighter threads between rocks, a capital keeps to the wide lanes it can actually turn in.

## How it works

- **You pick the point; the server finds the way.** Your client asks the server for a route from your ship to the point. The server plans it for your own hull (its size, and for a capital its heading and turning circle) on the same navigation maps the AI pilots use, and answers with the turns to fly.
- **Your ship flies it with your controls.** The route is advice, not a new kind of movement: your client's helm turns it into ordinary thrust and turn inputs, exactly as the capital helm already does. Nothing new for the server to correct (from navigation slice 13).
- **Wide lanes first.** Routes favour wide space; narrow streets carry a high cost, so they are taken only when they save a lot (owner, 2026-11-17).
- **No way through?** You are taken as close as your ship can get, and it waits there.
- **Capitals commit.** A capital that enters a lane goes on to its far end: no route turns it round inside a lane, where it has no room to turn.
- **Open space** (a sector with no asteroid field) answers "fly straight" at once.
- **You see the whole route.** A thin green line runs from your ship through the turns still ahead to the green move marker, with a small dot at each turn; turns drop off as you pass them. Until the route arrives (well under a second, a few seconds on the first course after joining) the line runs straight to the point. It is drawn the same way as the fleet patrol route (`render/routeLine.ts`, owner 2026-11-17 "whole route line").
- **Packed rock** (navigation guide, fine layer): in a densely packed part of a field a fighter crosses only by the field's streets; an open pocket off every street is sealed for the planner, so a course out of it ends at once (`none`) and one into it stops at the nearest reachable spot.

## Limits

- One route request at a time per player, and at most two a second; extra requests are ignored, and the client simply asks again.
- **Setting a course:** tap empty space (every hull). WASD or the stick cancels it. Every hull shows the helm panel (owner, 2026-11-18).
- **Flying the route:** the helm steers at each turn in order and moves on to the next one as soon as it is within its turn lead (`helmPassRadius`: about how far the ship travels while it comes round), so it sweeps through bends rather than stopping at each. Only the last leg brakes and arrives; arrival is within the hull's own size (`helmArriveRadius`).
- **Reply lost or late:** a reply older than the current course is ignored; one that never comes is asked for again after 5 s, and the ship flies straight at the point meanwhile.

## Status

- Slice 12 (2026-11-18): the request and reply on the wire, served by the room.
- Slice 13 (2026-11-18): the helm flies the route on every hull (`core/helm/helm.ts` route + pass radius; `client/helm/helmRoute.ts` asks and loads the reply). Locks: `helm.test.ts`, `helmRoute.test.ts`, e2e `autopilot-round-rock.spec.ts` (a fighter flies round a field rock to the far side). 
- Slice 14 (2026-11-18): the route line on screen (`render/routeLine.ts`, shared with the fleet patrol pick; `HelmCourseMarker` draws ship → turns → point). Locks: `routeLine.test.ts`, `helmCourseMark.test.ts`, `HelmCourseMarker.test.ts`.
- Internals: [navigation](../architecture/navigation.md#the-players-autopilot-asks-servernavautopilotroutests).
