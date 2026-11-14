# Handoff: 2026-11-13 night (capital break-up landing, sub-capital break-up)

Picks up from [HANDOFF-2026-11-13.md](HANDOFF-2026-11-13.md). Plan for the sub-capital work: `C:\Users\alecv\.claude\plans\subcapital-breakup.md` (desktop).

## Capital break-up (look done; landing on auto-merge)

On main: fracture v7 (#537), heavy parting with collision (#538), the far-half hit fix (#543), the v7 crack lock (#544), and sub-cap slice 1, the profile (#546).

On auto-merge, landing unattended:

| PR | What |
|---|---|
| #539 | The crack front and ripples. #540 (hull held until every piece is drawn) and #541 (crack look, smaller kill blast, test floor from design) are folded in, so #540 and #541 close when #539 merges. |
| #542 | Overkill knock-back, plus a rigid hull during the 1.2 s hold. |
| #547 | Wreck descriptors sent as adds/removes, with a rolling resync. Sub-cap slice 3. |

If one of them goes DIRTY: it is usually `docs/LESSONS.md`, `src/core/CLAUDE.md` (v6 / v7 / "pieces collide" lines) or `shipScale/tuning.ts` (both sides add fields). Keep both sides.

## Sub-capital break-up (look approved; performance not yet good enough to switch on)

**Owner verdict on v6** (film from `origin/subcap-combined`): "great". v6 fixed the owner's last quibble, "spin too much". The owner decisions behind the look:
- every ship breaks into 2–3 pieces, fighters included;
- the normal death explosion at half size;
- a thin warm-orange cut-edge glow for ~1 s;
- NO darkening ("why would it darken when destroyed? It should just be broken");
- pieces are permanent and drift to rest, then sleep;
- NPC loot pods use the normal colour and drop beside the wreck.

**Branches** (none of them is a PR yet; all are behind the off-by-default switch `subcapWrecks` / `EQX_SUBCAP_WRECKS=1`):
- `subcap-combined`: slice 2 (server), slice 4 (client look), all the look fixes and polish, plus three cost fixes:
  - the client prediction world keeps sleeping pieces asleep and streams pieces by distance;
  - light hits don't wake resting debris, and pieces settle to sleep after 0.5 s;
  - the renderer mirror post is a change set.
- `soak-combined`: `subcap-combined` plus the soak measurement tools. The results are in `docs/architecture/capital-destruction.md` under "Soak results".
- `perf/subcap-final`: work in progress, possibly partial. It adds a ~600 u prediction radius for wreck pieces and merges #547. See its last commit message.

**Soak numbers** (`fleet-fight-soak-lite`, about 1,200 ship deaths in one 1–2 km patch over 10 min, auto-slowdown OFF because it is a test room):
- before: the client dropped at ~600–700 pieces;
- now: smooth to ~1,050–1,470 pieces, and the client drops at ~1,440–1,710;
- older debris asleep: 73–77 %.

**Owner direction:** no hard 2,000 cap target. "Design would keep the numbers to the levels you're talking about"; the game's own time dilation is the safety valve. Remaining costs, in order: the client prediction world (the 600 u radius addresses it), the wire (#547 addresses it), and the server physics step under contacts.

## Next (in order)

1. **Finish `perf/subcap-final`:** the 600 u prediction radius for wreck pieces (with a body-count lock), and the #547 merge (~6 conflicts; keep both sides; `ColyseusClient.ts` has mixed line endings).
2. **Run the realistic soak** with time dilation ON (`autoTimeScale: true` in a soak-lite variant): does the controller slow the sector, and does the client stay smooth? One take without dilation for comparison.
3. **Turn the sub-cap branches into PRs** (slices 2 and 4 plus the fixes, behind the switch). The count gates exceed their budgets with the flag on, in the first ~12 s of fresh debris. Don't widen them; with the flag off they pass.
4. **Owner decision:** switch the capital and sub-cap break-up on in normal play.

Later (shelved): the weighted break-up roll (SHELF.md), cargo holds that drop as cargo (SHELF.md), structures breaking up (in the plan), capital S2c (persisting wrecks), missiles checking a capital's real hull (they burst on its bounding circle; found by #543).

## Housekeeping

- Many worktrees under `.claude/worktrees` came from today's agents. Merged branches can go; keep `subcap-combined`, `soak-combined`, `perf/subcap-final` and `subcap-film`.
- The perf runner left nested `perf-base` worktrees, each with a `node_modules` link. Remove the link with `rmdir` before removing the worktree.
