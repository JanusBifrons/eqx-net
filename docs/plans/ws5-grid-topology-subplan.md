# WS-5 Grid Topology Sub-Plan (R2.17 + R2.10)

## Intent

Tighten the structure-grid topology rules so the Capital is a constrained anchor, not a free-for-all attachment point: introduce a **capital-only-connectors** rule (the Capital may only link to Connectors — leaves must route through a relay) and a **per-kind connection range** (the Capital reaches a shorter distance than the global 600 u), then surface those rules in the placement preview (R2.17) so the player sees green "would-connect" lines and a red "over-cap" overflow before committing. Each PR is individually shippable: PR 1 lands the pure topology rules + catalogue change (the gameplay-defining change); PR 2 lands the multi-connect placement behaviour + the preview overflow visual on top. This sub-plan folds in the harden pass: the `connectionRange` field and the `capital-only` reason **do not exist yet** (they are net-new schema/enum additions, not edits), the preview pass and its count **already exist** (only the red-overflow visual + multi-connect are missing), and `autoConnectStructure` connects to the **nearest hub only** today.

---

## Current state (file:line, verified)

1. **`src/core/structures/Grid.ts:45-52`** — `CanConnectReason` is `'self' | 'duplicate' | 'hub-required' | 'a-full' | 'b-full' | 'out-of-range' | 'blocked'`. **`'capital-only'` is NOT a member** — it must be ADDED (a new exhaustive-union variant; every consumer/test that switches on the reason gains a case).
2. **`src/core/structures/Grid.ts:158-173`** — `canConnect` order today: `self` (158) → `hub-required` (161, `if (!a.isHub && !b.isHub)`) → `duplicate` (164) → `a-full` (167) → `b-full` (169) → `out-of-range` (171, `edgeDistance(a,b) > CONNECTION_MAX_RANGE`) → `blocked` (172). The range gate reads the **global** `CONNECTION_MAX_RANGE` (imported line 22); there is **no per-node range** today.
3. **`src/core/structures/Grid.ts:26-43`** — `GridNode` carries `isHub`, `isCapital`, `maxConnections` but **no `connectionRange`** field. (`isCapital` already exists — the capital-only rule needs no new node field, only `connectionRange` does.)
4. **`src/core/structures/structureGridConstants.ts:22`** — `CONNECTION_MAX_RANGE = 600`. No `CAPITAL_CONNECTION_RANGE` constant exists.
5. **`src/shared-types/structureKinds.ts:48-128`** — `StructureKindSchema` (zod, `.strict()`). Fields include `maxConnections` (78), `isHub` (82). **No `connectionRange` field exists in the schema** — adding it is the first real implementation work (it is net-new, NOT an edit of an existing field).
6. **`src/shared-types/structureKinds.ts:137-150`** — `CAPITAL`: `maxConnections: 4, isHub: true, radius: 80, powerOutput: 50, constructionCost: 0`. No `connectionRange`.
7. **`src/shared-types/structureKinds.ts:153-166`** — `CONNECTOR`: `maxConnections: 6, isHub: true, radius: 24, constructionCost: 80`.
8. **`src/shared-types/structureKinds.ts:169-182`** — `SOLAR`: `maxConnections: 1, isHub: false, radius: 40`. (Other leaves: `MINER` 185-212, `TURRET` 215-243, `BATTERY` 249-264 are all `isHub: false`. `SHIELD_PYLON` 271-285 is `isHub: true, maxConnections: 3`.)
9. **`src/shared-types/structureKinds.ts:314`** — `STRUCTURE_KIND_CATALOGUE_VERSION = 3`.
10. **`src/server/structures/structureGridView.ts:58-85`** — `autoConnectStructure` finds the single `best` (nearest, line 69 `let best: string | null = null`), iterating `registry.all()` filtered by owner (73) + `canConnect` (75), then makes **ONE** `registry.addConnection(newId, best, ...)` (83) and returns `best`. **No multi-connect; nearest-only.**
11. **`src/client/render/pixi/ConnectorRenderer.ts:54`** — `placementPreviewConnectionCount` field exists.
12. **`src/client/render/pixi/ConnectorRenderer.ts:214-291`** — `drawPlacementPreview` **already exists and works**: it builds reused-scratch nodes/adjacency/obstacles, iterates `nodes.values()` calling the same `canConnect` the server uses, classifies each as `'ok' | 'blocked' | 'skip'` (267-276), draws ok+blocked lines (only `'skip'` is not drawn, 277), counts `okCount` and publishes `placementPreviewConnectionCount = okCount` (290). **There is NO 6-cap, and NO distinct "would-connect-but-over-cap → RED" overflow class** — over-cap hubs fall into the existing `'skip'` bucket (their `canConnect` returns `a-full`/`b-full`).
13. **`src/client/render/pixi/ConnectorRenderer.placementPreview.test.ts:89-172`** — 4 tests: count ≥ 1 in range (90), count 0 blocked by asteroid (114), count 0 no preview (136), count 0 out of range (154). **No overflow / RED-line / 6-cap test exists.**
14. **`src/server/structures/StructurePlacementSubsystem.ts:115`** — `place()` calls `autoConnectStructure(this.hooks.registry, id, this.hooks.getObstacles?.())` once per placement; the multi-connect behaviour lives entirely inside `autoConnectStructure`, so PR 2's server change is localised there.

### What the topology rule is TODAY (the thing being changed)

- Capital is a hub (`isHub: true`); the hub rule (`Grid.ts:161`) lets **any leaf attach directly to the Capital** if at least one endpoint is a hub. A solar 120 u from the Capital connects fine (proven by `Grid.test.ts:86-87`).
- Range is global 600 u for every pair (`Grid.ts:171`).
- Auto-connect links a new structure to the **single nearest** qualifying hub.

---

## Phases

### PR 1 — Topology rules: capital-only-connectors + per-kind connection range

Pure-core + catalogue change. No client, no server-placement change. Individually shippable: it changes which links are *legal*; auto-connect (still nearest-only) and the preview (already classifies via `canConnect`) inherit the new legality for free.

**Change:**

1. **Add the `connectionRange` field to the schema.** In `StructureKindSchema` (`structureKinds.ts`, after `maxConnections` at line 78) add:
   ```ts
   /** Optional per-kind max edge-to-edge connection range (world units).
    *  ABSENT ⇒ the global CONNECTION_MAX_RANGE applies. Only the Capital
    *  overrides today (shorter reach forces relay chaining). */
   connectionRange: z.number().positive().optional(),
   ```
2. **Add `CAPITAL_CONNECTION_RANGE = 400`** to `structureGridConstants.ts` (a new export beside `CONNECTION_MAX_RANGE`). Doc it as "2/3 of the global 600; constrains the Capital's attachment footprint so distant leaves require an interior Connector relay."
3. **Set `connectionRange: 400` on the `CAPITAL` record** (`structureKinds.ts:137-150`). Import `CAPITAL_CONNECTION_RANGE` is NOT possible (catalogue is in `shared-types`, the constant in `core`, and `shared-types` must not import `core`) — so write the literal `400` with a comment referencing `CAPITAL_CONNECTION_RANGE`. Leave all other kinds without the field (they inherit the global 600).
4. **Add `connectionRange?: number` to the `GridNode` interface** (`Grid.ts:26-43`) and propagate it in BOTH projectors:
   - server `structureGridView.ts:structureToGridNode` (line 20-35): `connectionRange: kind.connectionRange` (undefined when absent — fine).
   - client `mirrorToGridNode.ts:structureMirrorToGridNode` + `ghostToGridNode` — set `connectionRange` from `getStructureKind(...).connectionRange` (so the preview honours the Capital's shorter reach). The `blankGridNode` factory in `ConnectorRenderer.ts:30-43` must also initialise `connectionRange: undefined`.
5. **Add the `'capital-only'` `CanConnectReason` variant** (`Grid.ts:45-52`, insert before `'blocked'`).
6. **Implement the two rules in `canConnect`** (`Grid.ts`). Insert the capital-only gate **after** `hub-required` (161) and **before** `duplicate` (164) so the reason is unambiguous (a leaf at a full Capital must read `capital-only`, not `a-full`):
   ```ts
   // Capital-only-connectors: the Capital may ONLY link to a Connector.
   // A leaf (or a non-connector hub, e.g. a shield pylon) attaching directly
   // to the Capital is rejected — route through a Connector relay instead.
   if ((a.isCapital && b.id !== /*connector?*/ ...) || (b.isCapital && ...))
   ```
   The "is the other endpoint a Connector?" test needs a Connector discriminator on `GridNode`. **`GridNode` has `isHub` + `isCapital` but no `isConnector`** — a Connector is "a hub that is not the Capital". So the precise rule is:
   ```ts
   if ((a.isCapital && !(b.isHub && !b.isCapital)) ||
       (b.isCapital && !(a.isHub && !a.isCapital))) {
     return { ok: false, reason: 'capital-only' };
   }
   ```
   (`b.isHub && !b.isCapital` ≡ "b is a Connector"; a shield pylon is a hub-but-not-Capital so it would ALSO satisfy this — see Open Decision 5 on whether pylons should be allowed on the Capital. The literal above treats pylon-on-capital as ALLOWED because a pylon is `isHub && !isCapital`. If the intent is "Connectors ONLY, not pylons", the test must key on a real `kindId`/`isConnector` flag — flag this to the user.)
   Then change the range gate (171) to use the per-node range:
   ```ts
   const maxRange = Math.min(a.connectionRange ?? CONNECTION_MAX_RANGE,
                             b.connectionRange ?? CONNECTION_MAX_RANGE);
   if (edgeDistance(a, b) > maxRange) return { ok: false, reason: 'out-of-range' };
   ```
   Using `min` of the two endpoints' ranges means the Capital's 400 u caps any pair it is part of, while two non-capital structures keep the full 600 u. (Decision: `min` not `a`'s range — a connection is symmetric, so the more-restrictive endpoint wins. Locked by a test.)
7. **Bump `STRUCTURE_KIND_CATALOGUE_VERSION` 3 → 4** in the SAME PR (the `connectionRange: 400` on the published `CAPITAL` row is a numeric catalogue change — invariant #11). Do NOT bump if `connectionRange` were only added to the schema without populating it (it is populated, so the bump is correct).

**Files:** `src/shared-types/structureKinds.ts`, `src/core/structures/structureGridConstants.ts`, `src/core/structures/Grid.ts`, `src/server/structures/structureGridView.ts`, `src/client/structures/mirrorToGridNode.ts`, `src/client/render/pixi/ConnectorRenderer.ts` (blankGridNode init), `src/core/structures/Grid.test.ts`.

**Failing-first test (RED on today's code):**

- **Split `Grid.test.ts:84-88`** ("ACCEPTS leaf ↔ connector and leaf ↔ capital") into TWO tests:
  1. `'ACCEPTS leaf ↔ connector (the relay path)'` — keeps line 85's `canConnect(sol, con, …).ok === true`. This stays GREEN (regression lock for the relay path).
  2. **`'REJECTS leaf ↔ capital (capital-only-connectors rule)'`** — the NEW failing-first vehicle. `const solNearCap = solar('sol2', 120, 0); expect(canConnect(solNearCap, cap, …)).toEqual({ ok: false, reason: 'capital-only' });` On today's code this returns `{ ok: true }` ⇒ **RED**. (Today it is wrongly green because the line-85 connector assertion in the combined test passes FIRST and the line-87 capital assertion only checks `.ok` — splitting is what exposes the failure.)
- Add **`'ACCEPTS connector ↔ capital (hub ↔ hub is still legal)'`** — guards that the new gate does NOT reject the Capital↔Connector bridge (the existing `Grid.test.ts:90-92` already covers this; keep it as the regression lock, no change needed).
- Add **`'enforces the Capital's shorter connectionRange (400 u)'`** — a Connector at edge-distance 450 from the Capital (in range under global 600, OUT under the Capital's 400) returns `{ ok: false, reason: 'out-of-range' }`; the same Connector pair NOT involving the Capital at 450 u returns `{ ok: true }`. RED today (no per-node range).

---

### PR 2 — Multi-connect on placement + preview overflow visual (R2.17)

Builds on PR 1's legality. Two coupled changes that MUST ship together (a multi-connect placement with no preview update would silently over-connect; a preview overflow with nearest-only placement would lie about what placement does):

**Change:**

1. **Multi-connect in `autoConnectStructure`** (`structureGridView.ts:58-85`). Replace the nearest-only loop with: collect ALL owner-matched, `canConnect`-passing hubs in range; sort by `edgeDistance` (deterministic — also tiebreak by `id` for stable ordering, harden finding); iterate adding `registry.addConnection(newId, hubId, ...)` for each until the **new structure's `maxConnections`** is hit OR a global `PLACEMENT_MAX_CONNECTIONS = 6` cap is reached; re-check `canConnect` per iteration (each added connection mutates the adjacency, so a hub that was free may fill, and the new node's own slot count rises). Return the **first** connected id (nearest) for backward-compat with the current `string | null` return. If none qualifies, return `null` (unchanged).
   - **Determinism note (harden):** iterate hubs in `(edgeDistance, id)` sorted order so multi-structure placement is reproducible across runs (no Map-iteration-order flake).
   - Add `PLACEMENT_MAX_CONNECTIONS = 6` to `structureGridConstants.ts` (or read it as a comment-justified literal). See Open Decision 7 on whether this should be a per-kind catalogue field vs a global constant — default to the global constant for this PR.
2. **Preview overflow visual** (`ConnectorRenderer.drawPlacementPreview`, line 214-291). Today every hub is `ok` (drawn green, counted) / `blocked` (red) / `skip` (not drawn). Add a fourth class: a hub that **would connect but is past the 6-cap** draws as a distinct RED overflow line and is NOT counted in `placementPreviewConnectionCount`. Mechanism: after computing per-hub `canConnect`, sort the `ok` hubs by distance, take the first `min(okCount, 6)` as green (counted), render the remaining `ok` hubs as a NEW `'overflow'` `lineKind` (red, via a new branch in `previewLineVisualParams` in `connectorVisual.ts`). `placementPreviewConnectionCount` becomes `min(okCount, 6)`.
   - Allocation discipline (invariant #14): the preview pass already uses module-scratch (`_previewNodes`, `_nodePool`, `_adjPool`). Sorting the ok-hubs needs a reused scratch index array — add a `private readonly _okHubScratch: number[] = []` field and reuse it (`.length = 0` then push), do NOT allocate per frame.

**Files:** `src/server/structures/structureGridView.ts`, `src/core/structures/structureGridConstants.ts` (the `PLACEMENT_MAX_CONNECTIONS` const), `src/client/render/pixi/ConnectorRenderer.ts`, `src/client/render/pixi/connectorVisual.ts` (the `'overflow'` line params), `src/core/structures/Grid.test.ts` (multi-connect), `src/client/render/pixi/ConnectorRenderer.placementPreview.test.ts` (overflow).

**Failing-first tests (RED on PR-1-landed code):**

- **`Grid.test.ts` / a new `structureGridView` test — `'a newly placed structure connects to ALL in-range hubs up to the 6 cap'`**: seed a registry with 6 in-range Connectors + 1 solar; call `autoConnectStructure`; assert `registry.adjacencyMap()` shows the solar connected to as many hubs as its `maxConnections` allows (solar cap is 1 — see below) — OR use a Connector (cap 6) as the placed structure so all 6 connect. On today's (PR-1) code only 1 (nearest) connects ⇒ RED. **Pick the placed kind so the cap under test is the 6-global-cap, not the leaf's own cap-1** (a solar can only ever hold 1 link; to exercise multi-connect to 6, place a **Connector** among 6 capitals/connectors). State this explicitly in the test docstring.
- **`ConnectorRenderer.placementPreview.test.ts` — `'caps green preview lines at 6 and draws the 7th+ as RED overflow'`**: 8 in-range qualifying hubs + a ghost; assert `placementPreviewConnectionCount === 6` (capped) AND that the gfx drew 2 overflow (red) lines. On PR-1 code `okCount` would be 8 and there is no overflow class ⇒ RED. (Reading the actual drawn line classification, not a recompute — per the feedback-test-observable lesson; expose an overflow-count test hook on the renderer mirroring `placementPreviewConnectionCount` if the gfx is not directly inspectable.)

---

## Catalogue version bump

`STRUCTURE_KIND_CATALOGUE_VERSION: 3 → 4`, landed in **PR 1** (same PR as the `CAPITAL.connectionRange: 400` addition). Rationale: invariant #11 requires a bump on any numeric-field edit to a published kind, and adding a per-kind range distance to the `CAPITAL` row is a numeric parameterisation of a wire/persistence-relevant kind. The `connectionRange` field is `.optional()` so absence stays byte-safe for every other kind, and `STRUCTURE_KINDS_LIST` order is unchanged (append-only contract intact — no kind added/removed/reordered). PR 2 adds no catalogue field (the `PLACEMENT_MAX_CONNECTIONS` cap is a `core` constant, not a catalogue row), so **no second bump**.

---

## Golden-master rewrites (deliberate)

1. **`Grid.test.ts:84-88` SPLITS (deliberate behaviour flip).** The combined "ACCEPTS leaf ↔ connector and leaf ↔ capital" test becomes two: "ACCEPTS leaf ↔ connector" (unchanged assertion, regression lock) + "REJECTS leaf ↔ capital (capital-only rule)" (the flipped golden — `{ ok: false, reason: 'capital-only' }`). This is the one intentional golden FLIP; it encodes the headline rule change.
2. **`Grid.test.ts:90-92` UNCHANGED (regression lock).** Connector ↔ Capital stays `{ ok: true }` — the capital-only gate explicitly permits a Connector on the Capital. Keep verbatim; it proves the new gate didn't over-reject.
3. **`Grid.test.ts:102-119` UNCHANGED.** `maxConnections` caps (leaf-rejects-2nd, connector-rejects-7th) are orthogonal to topology rules — they must stay green, proving PR 1 didn't perturb the slot-cap logic.
4. **`Grid.test.ts:121-125` (out-of-range) UNCHANGED but JOINED by a sibling.** The existing global-range test stays; PR 1 ADDS the Capital-shorter-range test beside it (does not rewrite the existing one).
5. **`Grid.test.ts` obstacle suite (138-182) UNCHANGED.** Item-D LOS/asteroid tests don't touch topology rules.
6. **`ConnectorRenderer.placementPreview.test.ts` (89-172) UNCHANGED; JOINED in PR 2.** The 4 existing count tests stay green (PR 1 doesn't change preview classification beyond what `canConnect` now returns; a capital-bound solar simply moves from `ok` to `skip` — and none of the 4 tests place a leaf against the capital, so they're stable). PR 2 ADDS the overflow test. **Verify after PR 1:** test 1 (count ≥ 1 connector→capital at 300 u) — the ghost is a `'connector'`, so the capital-only rule does NOT bite (connector↔capital is legal) and 300 u is within the Capital's 400 u range, so it stays GREEN. No rewrite needed.
7. **No DamageRouter/wire/byte golden touched.** This sub-plan does not alter the swarm wire, the `structures[]` snapshot slice shape, or any encoder — the `connectionRange` field never crosses the wire (it's catalogue-resolved on both sides from the `shipKind` byte). So the netgate-relevant byte-identity is unaffected by the FIELD; it IS affected by multi-connect (more `connTo` entries in the JSON slice) — see Risks.

---

## Risks / boundaries

1. **Existing saved bases with leaves directly on the Capital become topologically invalid (gameplay break).** Persisted connections live in the registry/DB; after PR 1, the UI/preview will reject re-forming such a link, and any code that re-validates an existing connection via `canConnect` (e.g. a future re-wire) will now reject it. Today nothing auto-severs existing connections on a rule change, so old links persist in-memory but can't be recreated. Boundary: PR 1 does NOT add a migration that severs/re-wires existing capital-leaf links — that is out of scope (Open Decision 1). Treat as a known breaking change surfaced at playtest.
2. **`connectionRange` is an OPTIONAL field — old-client/new-server skew.** The field is catalogue-resolved on each side (never on the wire), so a stale client computes the Capital's range as the global 600 u while the new server applies 400 u. Effect: the client's placement *preview* could show a Capital connection the server then refuses. LOW risk (the catalogue is bundled with each build; a deployed client always reads its own catalogue), but the catalogue-version bump (3→4) is the canary — a version-mismatched persisted row is handled by the existing drift safety. Lock with a test asserting `structureToGridNode` / `structureMirrorToGridNode` propagate `connectionRange` so both sides read 400.
3. **Multi-connect changes the `structures[].connTo` JSON slice → netgate surface.** PR 2 makes a freshly-placed structure emit up to 6 `connTo` entries instead of 1. That widens the `structures[]` snapshot slice the moment a base is built. Per invariant #8 + the server-CLAUDE "Phase 3 grid changes require netgate" note, **PR 2 requires `pnpm e2e:netgate`** (PR 1 is pure-core + catalogue, no live-loop bytes — netgate not strictly required but cheap to run). Boundary: the slice SHAPE is unchanged (still `connTo: number[]`), only its length grows, so no decoder/version change.
4. **`canConnect` re-check cost in the multi-connect loop.** `autoConnectStructure` now calls `canConnect` O(hubs²)-ish per placement (each added connection re-checks the rest). Placement is a low-frequency wire event (not a 60 Hz tick), and grids are small (capital `maxConnections` 4, 6-cap global), so this is NOT a hot-loop allocation concern (invariant #14) — but the loop MUST reuse the already-built `nodes`/`adjacency` maps and NOT rebuild them per added connection (rebuild once, mutate the adjacency length in place, or rebuild only if `registry.addConnection` invalidates the cached map — verify which). Boundary: keep the per-placement work O(hubs × cap), cap ≤ 6.
5. **Pylon-on-Capital ambiguity (capital-only literal).** The proposed `canConnect` literal (`!(b.isHub && !b.isCapital)`) treats a Shield Pylon (a hub-but-not-capital) as a LEGAL Capital attachment — because "not the Capital + is a hub" ≡ Connector OR Pylon. If the design intent is "Connectors ONLY", the gate must key on a real Connector discriminator (a `kindId === 'connector'` check or a new `isConnector` GridNode flag), NOT `isHub && !isCapital`. This is Open Decision 5 — do NOT silently pick one; flag the trade-off (it changes whether pylon-defended capitals are buildable).
6. **`min`-of-ranges symmetry.** Using `min(a.range, b.range)` for the range gate is the chosen rule (a symmetric connection's tighter endpoint wins). If a future kind has a LARGER-than-global range, `min` still clamps correctly. Locked by test; do not switch to `a.range` only (would make the gate order-dependent — `canConnect(a,b)` ≠ `canConnect(b,a)`).

---

## Open decisions for the user

1. **Existing capital-leaf bases — migrate, grandfather, or break?** Post-PR-1 a base with a solar directly on the Capital is invalid. Options: (a) ship a one-time migration that inserts a Connector and re-wires, (b) grandfather existing direct links as a deprecated legal path (a `legacyDirect` flag on the connection that bypasses `canConnect`), or (c) accept the break and let playtest drive a UI prompt. The plan is coded for (c); (a)/(b) need extra work. **Which?**
2. **Capital range = 400 u?** Chosen as 2/3 of the global 600. Is this the right value, or should it be 300/350/450? (Adjustable via the `CAPITAL_CONNECTION_RANGE` constant; the question is the playtest target spacing.)
3. **Should the Capital's `connectionRange` ALSO apply to the Connector↔Capital bridge?** As specified, `min(400, 600) = 400` caps the bridge at 400 u too — so a Connector must be within 400 u of the Capital. Intended, or should the Capital→Connector link keep the full 600 u (i.e. the short range applies only to leaf-reach, but leaves can't touch the Capital anyway, making the field moot for leaves)? If the latter, `connectionRange` is effectively "how far the Capital's Connectors may sit" — confirm that's the intent.
4. **6-connection cap — per-kind catalogue field or a global `core` constant?** PR 2 uses a global `PLACEMENT_MAX_CONNECTIONS = 6`. Should it instead be a per-kind override (like `maxConnections`) so a future tier-2 hub can exceed 6, or stay a single global cap? (A catalogue field would mean a SECOND version bump in PR 2.)
5. **Capital-only: Connectors ONLY, or "any non-Capital hub" (incl. Shield Pylons)?** The literal `isHub && !isCapital` admits pylons onto the Capital. Restricting to Connectors only needs a real Connector discriminator. Which?
6. **Multi-connect at placement: notify the player?** When a placed structure auto-connects to up to 6 hubs, the preview lines already show the intent. Is the silent grid-pulse "it's connected" enough, or do you want a toast/HUD note listing how many links formed?
7. **Partial cap feel.** A Connector placed near 3 Capitals connects to at most... however many Capitals have a free slot AND are within the (now 400 u) range AND the Connector hasn't hit its own cap 6. A player might expect "connect to everything in range" but get fewer. The preview shows the truth, but is the cap-driven shortfall acceptable UX, or should over-cap hubs be visually distinguished further (e.g. a count badge)?
