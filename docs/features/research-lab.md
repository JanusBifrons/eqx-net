# Research Lab (economy v2 W3)

Plan `peppy-jumping-pinwheel`, economy v2. The Research Lab is where
blueprints get better. It is EVE-style industry: research an original, copy
it, or gamble three blueprints into one better one.

## Playing it

- **Build a Research Lab** (Build ▸ Industry). It's a leaf structure that draws
  80 power and needs a link into your base, so it can reach your storage.
- **Select the lab** to open its panel. The panel lists every blueprint in
  your base storage by name, with:
  - a ★ glance score;
  - original or copy (with runs left);
  - material efficiency (−% materials) and output quality (Q).
- **Tap one original** for these jobs:

  | Job | Effect | Fee | Time |
  |---|---|---|---|
  | Research materials | +1 % material efficiency (max 10 %) | 60¢ × (level + 1) | 30 s × (level + 1) |
  | Research output | +10 output quality (max 100) | 60¢ × (level + 1) | 30 s × (level + 1) |
  | Copy ×1 / ×5 / ×10 | the original + a copy with that many runs and the same stats | 25¢ per run | 15 s per run |

- **Tap three blueprints for the same product** (all originals, or all
  copies) to **Combine**. It costs 200¢ and takes 90 s. The result:
  - has the best material and output of the three, plus a random bonus of
    +0–2 % materials and +0–15 quality, capped;
  - if the inputs were copies, keeps 60 % of their summed runs.

  A combine is never worse than its best input. The roll is decided by which
  three blueprints you combine, so cancelling and retrying gives the same
  result.
- **Rules while a job runs:**
  - the blueprints leave storage;
  - the panel shows progress and a **Cancel** button (the blueprints come
    back; the fee is spent);
  - jobs pause while the lab is unpowered;
  - when a job finishes, the results go back into your storage.
- **Fees come from your wallet.** If the lab is **destroyed** mid-job, its
  blueprints spill as a pod where it stood, so you can still get them back.

## How it works

- **Rules** live in `src/shared-types/research.ts`: `planLabJob`,
  `completeLabJob`, fees and times. They are pure, so the server runs them and
  the panel shows the same numbers.
- **Jobs** live in `src/server/economy/LabBoard.ts`: one persisted
  `economy_state` row (`lab_jobs`), hydrated at boot. A job record carries the
  blueprints it holds.
- **Room side** is `src/server/structures/ResearchLabSubsystem.ts`:
  - starting a job removes the inputs from storage, debits the wallet and
    writes the job record in ONE atomic group;
  - the 1 Hz grid pulse advances powered, built labs;
  - finishing and cancelling are also single groups;
  - removing the lab spills the held blueprints.
- **Messages** are `lab_query`, `lab_start` and `lab_cancel`, each answered by
  a full `lab_state` view (`src/shared-types/messages/labMessages.ts`). The
  panel (`ResearchLabPanel`) asks every second while it's on screen and is
  rebuilt from those replies only.

## Tests

- `src/shared-types/research.test.ts`:
  - research steps, caps and refusals;
  - copy;
  - combine (determinism, never worse, caps, refusals).
- `src/server/economy/LabBoard.test.ts`: persistence round trip, progress
  saves, corrupt rows.
- `tests/integration/sectorRoom/researchLab.test.ts`: research, copy,
  combine, busy, short wallet, cancel and destroyed-lab spill, all through a
  real room and the real messages.
- `src/client/components/ResearchLabPanel.test.tsx`: names only, fees shown,
  combine selection, job progress and Cancel, held verdicts.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Research Lab (economy v2 W3)**: `structures/ResearchLabSubsystem.ts` (room) + `economy/LabBoard.ts` (global, the `lab_jobs` economy-state row). **Rules:** (1) a running job HOLDS its blueprints (they leave storage at start) — the storage change, the job record and the wallet fee commit as ONE group (`StorageService.commitChanged`); never move a lab's blueprints any other way; (2) jobs advance only on powered, built pulses and finish into the lab's network storage (no storage ⇒ the finished job waits); (3) a lab leaving the world spills its job's blueprints as a pod (`onRemoved`, in the same eviction seam as storage spills); (4) the rules (fees, times, combine roll seeded from the input uids — no reroll by cancel+retry) live ONLY in `shared-types/research.ts`; (5) the panel is rebuilt from `lab_state` replies only (#16). Lock: `tests/integration/sectorRoom/researchLab.test.ts`. Story: [docs/features/research-lab.md](research-lab.md).
