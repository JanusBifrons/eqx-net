# Coastal Defences — the static gun catalogue

Static defences redesigned in line with the capital ships (plan
prancy-squishing-donut): the same WW2-calibre guns, the same turret art and the
same fire control, plus coastal guns no ship carried. Research:
`docs/research/ww2-coastal-defences.md`. Feature page:
`docs/features/coastal-defences.md`.

User decisions (2026-11-08): eqx-net; shells fly straight (same model as ship
shells, so big guns sit outside the fence on bastions); the top tier includes
the Lindemann 40.6 cm super battery AND an 80 cm Gustav-style siege gun; the
existing four energy/missile turrets are kept and moved onto the shared fire
control.

## Catalogue

| Kind | Real counterpart | Mount | Arc |
|---|---|---|---|
| `aa_quad_40mm` | Quad Bofors | AA / 4 / autocannon | 360° |
| `dp_mount_5in` | Twin 5"/38 DP | S / 2 / naval_s | 360° |
| `coastal_casemate_8in` | Batterie Hamburg 24 cm | M / 1 / naval_m | 120° |
| `coastal_turret_11in` | Austrått 28 cm triple | L / 3 / naval_l | 360° |
| `coastal_barbette_16in` | US 16"/50 casemated | XL / 2 / naval_xl | 144° |
| `coastal_lindemann` | Batterie Lindemann 40.6 cm | XL ×1.15 / 1 / naval_xxl | 120° |
| `siege_gun_80cm` | Schwerer Gustav 80 cm | XL ×1.6 / 1 / naval_siege (blast) | 60° |

## Stage Progress Tracker

- ✅ Stage 1 — Research doc (`docs/research/ww2-coastal-defences.md`)
- ✅ Stage 2 — Weapons (`naval_xxl`, `naval_siege` + projectile blast) and the seven structure kinds (append-only, no catalogue version bump)
- ✅ Stage 3 — Shared fire control (`core/combat/mountFireControl.ts`, `server/structures/StructureMountTicker.ts`), all-hostiles target query, server-written mount angles on the snapshot
- ✅ Stage 4 — Art: naval guns on structures (shared muzzle), emplacement bases, Gun Batteries build category
- ✅ Stage 5 — Base seeding: tiered defence mix on its own stream, bastions seat big guns first, casemates face out, region-heart super-guns (`BASE_GROWTH_VERSION` 10)
- [ ] Stage 6 — Docs (feature page, procedural-bases, military-bases, zone CLAUDE.md, LESSONS)
- [ ] Stage 7 — Showcase shots + filmed review + artifact

## Decision Log

- 2026-11-08 — Stage 2 — The four existing turret records are NOT changed (no `size` on their mounts): changing a record bumps `STRUCTURE_KIND_CATALOGUE_VERSION`, which discards every saved player structure. They still get the new fire control with the default "nearest hostile" priority.
- 2026-11-08 — Stage 2 — New weapon ids are `naval_xxl` / `naval_siege` (not `coastal_xxl` / `siege_xxxl`) so the client's `naval_` shell styling picks them up unchanged.
- 2026-11-08 — Stage 2 — Research found the ship doc's formulas (√ weight, rate^0.75) don't match the shipped naval numbers; the new guns follow the shipped curves so they line up with `naval_s..xl`.
- 2026-11-08 — Stage 2 — The quad AA fires the `autocannon` (kinetic, spends munitions) rather than the ship AA's `laser`: a Bofors is a cannon, and structures already ammo-gate shells.
- 2026-11-08 — Stage 3 — Kept the 100 ms turret tick (not 60 Hz): slewing uses the measured elapsed time, so traverse rates are exact; the client eases toward the server angle at 1.5× traverse to hide the tick.
- 2026-11-08 — Stage 5 — A region heart held alone by a stronghold/citadel (no garrison) mounts the super-guns itself, so every region has exactly one siege gun. Super-guns come with their own funding.
- 2026-11-08 — Stage 5 — A bastion's outward gun stands 130 u further out so guns above and below its hub still fit beside a big battery; military bases budget a bastion row per four guns (was six).
