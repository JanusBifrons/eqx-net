# Handoff: warp picker, keep both views (wrap-up plan W1a)

Paused 2026-11-08 because it overlapped another agent's work. Delete this file in the PR that finishes it.

## Where things stand

- **Plan:** wrap-up plan `prancy-squishing-donut` (in `~/.claude/plans/` on the first machine), step W1a: the warp destination picker for solar-system sectors.
- **Already on `main`:**
  - #348: the picker (list + map prototypes behind `?warpui=`), the "Warping to X / Cancel" chip, and the speed-dial "Warp ▸" action.
  - #349: rare transit pads (`pocket_pad`, `pocketPadPair`, `SectorRoom.seedPocketPads`), plus the picker's pad hint and the dashed pad line on the map.
  - #350: the CLAUDE.md rule to clean up memory before every recording.
- **The user's decision** after watching both clips: "Keep both, list for mobile." So the list is the default on touch devices and the map on desktop; `?warpui=list|map` overrides.
- **The user also asked:** "the map chooses a location bottom right and it goes straight right. Is that a bug? Does it only ever fly right?!"
  - Answer: no. The pick was Vega Reach gate, which is due east of Home in Sol Prime. Gates sit on the bearing toward their neighbour system, so the gate lies at (170000, 0).
  - A new integration test proves warps go any direction: `warpTo.test.ts`, "flies any direction: a south-west pocket, not just east". It passes.
  - **Tell the user this answer**; they haven't heard it yet.

## What this branch changes (uncommitted work, now committed here)

- `src/client/components/WarpPicker.tsx`:
  - `readWarpUi(search, touch)`: the URL wins, otherwise touch gets the list and desktop gets the map.
  - Map panel width is 360 (list stays 280).
  - Map labels are bigger (`H/7`) and sit right under their own dot, or above it on a clash or at the edge.
  - Smaller ship arrow with an outline, so the Home dot shows.
  - Readable Warp button (dark bold text).
  - List headers are 10 px bold and brighter; the pad hint is 11 px.
- `src/client/components/WarpPicker.test.tsx`: the list tests set `?warpui=list`; `readWarpUi` covers the touch and desktop defaults.
- `tests/integration/sectorRoom/warpTo.test.ts`: the "flies any direction" test.
- `showcase/shots/warpTo.ts`: comment only (the capture is desktop, so it films the map; `EQX_SHOWCASE_PARAMS=warpui=list` films the list).
- `docs/features/warp-to.md`: both views, and why Vega Reach gate is "straight right".

**Checks run:**
- `pnpm typecheck`;
- `WarpPicker.test.tsx` and `warpDestinations.test.ts`;
- the new integration test.

**Not run yet** on this branch: full `pnpm lint`, full `pnpm test`.

## What's left to do

1. **Re-film the map view** with the label fix: `pnpm showcase --shot warp-picker`.
   - Clean up memory first: CLAUDE.md "Clean up at every stage", including the new before-recording rule.
   - Run it in the FOREGROUND (8 GB laptop).
   - The re-film was interrupted, and its clip in `showcase-out/clips/warp-picker/` may be incomplete. Ignore it.
2. **Hostile review** of full-resolution frames around the key moments, per CLAUDE.md. Things to check:
   - the labels sit by their dots and are readable;
   - the Home dot is visible;
   - the Warp button is readable.

   From the previous review, these were judged not to be picker problems:
   - "ship turns into a cyan dash on arrival" was an artefact of downscaling (the ship is fine at full res);
   - the arrows that appear at the gate are NPC traffic streaming in;
   - warp streaks "through the HUD" show through transparent HUD panels.
3. **Optional polish** the reviewer raised:
   - **Tap feedback in the list:** the hover highlight stays on the row under the cursor.
   - **The pad hint shows on both ends:** it appears on the Home row and on the far row.
   - **The status chip pushes the Pilot/Spectate toggle down** about 40 px.
   - **A ~150–250 ms hitch when the speed dial opens:** `dispatchDiscreteEvent`, about 30–45 ms twice, at the FAB tap. Worth a profile, as it may be the SpeedDial with `tooltipOpen` labels.
4. **Ship it:**
   - sync `origin/main`;
   - run typecheck, lint and test;
   - open a PR and turn auto-merge on (`gh pr merge <n> --auto --merge`);
   - send the user the map clip and the answer to their "only flies right" question.
5. **Then continue the wrap-up plan** (the full plan with status is in `docs/handoff/wrap-up-plan.md`):
   - W1c: solar sectors on by default, with the netgate, a 10-minute soak, and a perf A/B on desktop and the phone proxy;
   - W1d: a `docs/architecture/solar-system-sectors.md` page;
   - then W2 onward.
