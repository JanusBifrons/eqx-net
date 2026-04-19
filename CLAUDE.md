# CLAUDE.md — EQX Peri (Root)

You are working in **EQX Peri**, a multiplayer space game. This file is your north star; read it before making any non-trivial change. Zone-specific rules live in:

- [src/core/CLAUDE.md](src/core/CLAUDE.md)
- [src/server/CLAUDE.md](src/server/CLAUDE.md)
- [src/client/CLAUDE.md](src/client/CLAUDE.md)

Non-obvious lessons learned during implementation go in [docs/LESSONS.md](docs/LESSONS.md).

The Master Architecture Blueprint is the authoritative design document; the approved phased plan file (under `C:\Users\alecv\.claude\plans\`) is the executable roadmap. When the blueprint and a zone CLAUDE.md appear to disagree, the most recently-updated CLAUDE.md wins (it reflects what was actually learned while building).

---

## Cross-Phase Invariants (ALL must hold at every phase gate)

1. **Boundary integrity.** `src/core` imports no client or server library. `src/server` imports no client library. `src/client` imports no server-only package or Node-only API. CI-enforced via `eslint-plugin-import` `no-restricted-imports`. The canary fixture at [src/core/\_\_fixtures\_\_/leak.ts.disabled](src/core/__fixtures__/leak.ts.disabled) exists to prove this enforcement is live; toggling its extension must break CI.
2. **Zustand purity.** No spatial field (`x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`) may appear in the Zustand store. Lint rule in `eslint.config.js` blocks it. Spatial state lives in the render mirror polled by Pixi; UI state lives in Zustand.
3. **Network validation.** Every inbound server message has a zod schema. Malformed packets are dropped with a sampled `pino.warn` — they never reach game logic.
4. **Fixed timestep.** `world.step(1/60)` inside a `while (accumulator >= fixedDt)` catch-up loop. No variable-dt physics anywhere.
5. **DI seams.** `src/core` never constructs a renderer / audio / network sink / persistence. Implementations are injected by the appropriate zone at bootstrap via the contracts in `src/core/contracts/`.
6. **SOLID adherence** (see below). Enforced at code-review time.
7. **CLAUDE.md currency.** Every PR that changes an invariant, adds a contract, introduces a threshold, or teaches a non-obvious lesson updates the relevant CLAUDE.md file in the same PR. If you find yourself about to merge without updating CLAUDE.md, stop and ask whether this PR is actually teaching something.
8. **Green bars before done.** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` all pass.

---

## Event Bus Architecture (read before adding any signalling)

EQX Peri uses **two distinct channels**, never blended:

- **Discrete event bus** (`eventemitter3`, wrapped in `src/core/events/Bus.ts`) — instantaneous low-frequency events only: spawn/despawn, fire, destroy, sleep/wake, TiDi rate change, transit state transition. Subscribers: Howler, Zustand, Pino, persistence.
- **Continuous state polling** — per-frame spatial data (positions, velocities, rotations) is read directly from the render state mirror / SAB. **Never** emitted as events.

Rules:

- Bus event shapes live as a single discriminated union in `src/core/events/Bus.ts`. No stringly-typed emits.
- Adding a continuous-data event is a code-review rejection.
- The renderer never subscribes to the bus for positions. Lint-enforced inside `src/client/render/`.
- The bus is per-process. Cross-process propagation happens over a wire (Colyseus, SAB, postMessage) and is re-emitted onto the receiver's local bus.

---

## Technology Stack Matrix

| Zone | Allowed runtime libs | Purpose |
|---|---|---|
| Root tooling | `typescript`, `vite`, `tsx`, `pnpm`, `vitest`, `@playwright/test`, `eslint` + `eslint-plugin-import`, `prettier` | Build, test, lint |
| `src/core/` | `@dimforge/rapier2d-compat`, `eventemitter3`, `zod` (types), TS stdlib. No DOM, no Node-only APIs (except `worker_threads` behind a contract). | Physics, event bus, pure logic, DI contracts |
| `src/server/` | `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `better-sqlite3`, `pino` + `pino-pretty`. Optional Phase 9 (multi-VM only): `@colyseus/redis-driver`, `@colyseus/redis-presence`. | Authoritative simulation host, persistence, lag comp, backpressure, orchestration |
| `src/client/` | `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand` | UI, rendering, audio, input, client prediction |
| `src/shared-types/` | Pure TS + zod schemas only | Cross-zone contracts (message shapes, SAB layout constants) |

---

## SOLID Adherence (project-specific bindings)

- **S — Single Responsibility.** Each zone has one concern; each module has one axis of change. `PixiRenderer` never handles input. `Reconciler` never touches rendering. `SectorRoom` never formats Pino lines directly.
- **O — Open/Closed.** New weapons / AI / sectors are added by implementing existing contracts (`IWeapon`, `IAiBehaviour`, `ISectorDefinition`), not by editing switch statements.
- **L — Liskov Substitution.** Any `IRenderer` (e.g., a headless test one) is drop-in for the Pixi one. Any `INetworkSink` (e.g., a loopback one) is drop-in for the Colyseus one.
- **I — Interface Segregation.** Contracts are narrow: `IRenderer`, `IAudio`, `INetworkSink` are separate, never merged.
- **D — Dependency Inversion.** `src/core` declares abstractions; server and client supply concretions via constructor injection at bootstrap. Dependency direction goes *into* core, never out — enforced by ESLint `no-restricted-imports`.

---

## Repo Map

- `src/core/` — zone-pure simulation. Read `src/core/CLAUDE.md`.
- `src/server/` — Node + Colyseus authority. Read `src/server/CLAUDE.md`.
- `src/client/` — Browser UI + rendering. Read `src/client/CLAUDE.md`.
- `src/shared-types/` — wire contracts.
- `tests/e2e/` — Playwright multi-browser scenarios.
- `benchmarks/` — vitest-bench suites.
- `docs/LESSONS.md` — chronological log of non-obvious findings.
- `.github/workflows/ci.yml` — the enforcement pipeline.
- `eslint.config.js` — boundary rules. Treat modifications here with great care; weakening a pattern is equivalent to weakening invariant #1.

---

## Phase-Gate Ritual

At each phase's acceptance gate:

1. **Update the relevant CLAUDE.md** for any zone whose rules, contracts, or thresholds changed.
2. **Append to `docs/LESSONS.md`** if this phase surfaced a gotcha, benchmark surprise, or failure mode.
3. **Review Cross-Phase Invariants** — if one was added or amended, update this file.

Phase 0 seeds all CLAUDE.md files; every subsequent phase amends them.

---

## Verification Protocol (apply after every server-touching change)

After any change to `src/server/` or its config, **boot the server before reporting success**:

```
timeout 8 pnpm dev:server
```

A clean boot prints `INFO: EQX Peri server started port: 2567` with no uncaught exceptions. A crash (exit code non-143) means the change broke the runtime even if typecheck passes — fix it before moving on. Exit code 143 is normal (SIGTERM from `timeout`).

This exists because TypeScript's type system cannot catch runtime issues like decorator transform mismatches, missing `Symbol.metadata`, or ESM resolution failures that only surface at Node.js startup.
