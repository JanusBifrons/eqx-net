# CLAUDE.md — plans/

Plans in this folder are **living documents** executed across multiple sessions on multiple machines. Treat them as canonical state, not reference material.

## Reading

- At the start of every session that touches a plan's scope, read the plan file end-to-end. The Stage Progress Tracker at the bottom is where you resume — find the lowest unchecked box.
- Don't restart a stage from scratch when checkboxes show partial progress. Trust the tracker.

## Writing

- **Tick checkboxes in the same commit as the code that earned them.** A future session reading the diff should see the work and the tick together.
- **Stage status lines** (⏳ pending / 🚧 in progress / ✅ done) get updated when the stage starts and ends. In progress means at least one micro-cycle has landed.
- **Decision Log entries** are mandatory whenever a discovery changes the plan: a stage spawns a sub-stage, a test-infra investment ballooned, an assumption proved wrong, scope was cut. Format: `YYYY-MM-DD — Stage N — what changed and why.` One line. Never silently divert from the plan.
- Don't delete completed sections. Don't restructure the plan unless the Decision Log entry justifies it. A future session needs to be able to reconstruct *why* something is the way it is.

## Retiring

When all stages are ✅ done and the corresponding measurements have landed in `docs/`, move the plan into `plans/archive/<plan-name>.md` and leave a one-line redirect in its place. The Decision Log is a permanent artefact — preserve it through the move.

## Scope of this folder

Roadmaps and multi-day initiatives. **Not** for: short-lived TODO lists (use `TaskCreate`), in-flight design exploration (use `~/.claude/plans/` for the planning phase, then promote here when approved), or completed-and-archived material (use `plans/archive/`).
