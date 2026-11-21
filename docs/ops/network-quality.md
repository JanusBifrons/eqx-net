# Network quality: tiers and who caused a gap

How to judge a play test's connection objectively, and how to tell network
trouble apart from server trouble and phone (device) trouble. The numbers come
from phone-lane captures ([phone-link](phone-link.md#play-evidence-read-this-after-a-play-test));
the field meanings are in [diagnostic-captures](../architecture/diagnostic-captures.md).

```
pnpm phone:verdict .claude/phone-lane/run/captures/<session> [<session> ...]
```

prints the tier, the reasons it is not one tier higher, the gap split between
server, network and device, and the device hitch rate. Code:
`scripts/dev/lane-net-verdict.mjs` (no deps; test `tests/unit/lane-net-verdict.test.ts`).

## The principle

**Latency alone doesn't cause jitter; variance and stalls do.** Every remote
thing on screen (drones, other ships, shells) is drawn from a display buffer a
fixed delay behind the newest update. The buffer hides any unevenness in
arrival times that is smaller than itself: a steady 150 ms connection looks
exactly as smooth as a steady 30 ms one, only later. What shows is an update
that arrives later than the buffer can cover: the drawing runs out of data and
glides (extrapolates) or holds, then snaps when the update lands.

So the two kinds of play need different things:

- **Piloting** needs a small buffer. The own ship is predicted at the present
  time ([prediction-and-correction](../architecture/prediction-and-correction.md)),
  so everything around it must be drawn as close to the present as possible;
  a big buffer would put the world visibly behind your own ship. Piloting
  therefore feels every gap the small buffer cannot cover.
- **Command / spectate** has no predicted ship, so it can use a large buffer.
  Sized to the outages, it stays smooth on almost any link; the cost is only
  that everything is a little delayed.

## Tiers

Judged on **network-attributed** numbers only (see the next section): a gap
the server or the phone caused is not a bad connection.

| Tier | RTT p99 | Lateness p95 | Network gaps over 200 ms | Piloting feel | Command / spectate feel |
|---|---|---|---|---|---|
| Good | < 100 ms | < 30 ms | < 2/min, none over 1 s | smooth | smooth |
| Playable | < 250 ms | < 150 ms | < 10/min, none over 1 s | some gliding, the odd snap | smooth |
| Poor | beyond Playable | | | bad | smooth but delayed, if the buffer is sized to the outages |

- **RTT** is the client's ping (`snapshot` events, `rttMs`). It is measured
  through the game loop, so a slow server inflates it. Only RTT samples from
  healthy-server windows count (next bullet); the rest are put down to the server.
- **Server rate** is ticks per second in 10 s windows of play, from
  `snapshot_received` pairs (`serverTick` delta over `serverSendPerfNow` delta).
  A window under 45 ticks/s (the target is 60; a loaded dev host sits at 46–56)
  or with one server send gap over 250 ms ran slow; RTT samples in it and the
  window after are excluded. The verdict prints the slow time separately
  (`server: slow N s (P% under 45 ticks/s, min X ticks/s)`); it is not a
  network tier input. The server also logs its own side of this
  (`server sim behind target tick rate` in `run/server.log`).
- **Lateness** is how late each update arrived compared with when the server
  sent it: client receive time minus the server's send stamp
  (`snapshot_received`: `clientRecvPerfNow` − `serverSendPerfNow`), above a
  baseline. The two clocks are not synchronised, so only the excess over the
  best offset seen means anything; the baseline tracks the minimum, creeps up
  1 % per update to absorb clock drift, and restarts after an arrival gap over
  1 s. Lateness is the variance number: it is what the display buffer must
  cover.
- **Gaps** are arrival gaps over 200 ms (`recvGapMs`), per minute of play.
  Receives in the first 3 s after a `welcome` are join catch-up and skipped.

A missing metric (no RTT samples, say) skips its bound; with no lateness and
no gaps at all the verdict is "No data".

### Reference captures

| Capture | Link | RTT p99 | Lateness p95 | Gaps over 200 ms | Split | Verdict |
|---|---|---|---|---|---|---|
| rumrpr | home Wi-Fi, two players | 68 | 12 | 7.6/min | 99 % server | Good |
| pvt5s8 | home Wi-Fi, two players | 69 | 13 | 7.1/min | 95 % server | Good |
| ja5x2s | not recorded | 68 | 12 | 0 | none | Good |
| 4zd6fw | not recorded; the phone hitched 43 times a minute | 117 | 29 | 1.2/min | 100 % server | Playable (RTT) |
| 1volvr | 4G | 454 | 640 | 29/min, a 5.1 s stall, a disconnect | 77 % network | Poor |
| o0xdo0 | 4G; the local server ran slow for 50 s (min 25 ticks/s) | 234 (999 with the slow-server samples) | 37 | 19/min | 96 % server | Playable |

The home Wi-Fi runs have about seven gaps a minute, yet they are Good: almost
all of those gaps are the server not sending (its own send stamps are already
250–300 ms apart), not the connection.

## Attribution: three clocks

Every gap over 200 ms is put down to one of three clocks, checked in order:

1. **Server**: the server's own send stamps for the same two updates
   (`serverSendPerfNow`) are at least half the arrival gap apart. The server
   sent late (a slow tick, a skipped send), so the connection is not to blame.
   Pairs whose server ticks go backwards or jump more than 600 ticks straddle
   a reconnect and have no server gap.
2. **Device**: the server sent on time, but the phone's main thread was blocked
   (`raf_gap`, `loaf`, `longtask` in `perf.ndjson`) for at least half of the
   unexplained part of the gap. The update was waiting in the socket; the page
   could not read it. Separately, the device's own frame health is the hitch
   rate (frames over 50 ms per minute, from `perf_summary`), regardless of
   data; over 6/min the phone itself stutters.
3. **Network**: the server sent on time and the phone was free, yet the update
   arrived late.

Only network gaps count toward the tier. A server-heavy split points at the
server (see `run/server.log` and the tick telemetry); a device-heavy split or a
high hitch rate points at client performance ([perf-device-capture](../architecture/perf-device-capture.md),
`pnpm phone:names` for the code behind a stall).
