# EQX Peri

Multiplayer space game built on a strict server-authoritative architecture (Colyseus + Rapier + Pixi + React/MUI).

## Zones

- `src/core/` — blind simulation (Rapier + event bus + DI contracts)
- `src/server/` — Colyseus authority + persistence
- `src/client/` — React/MUI + Pixi renderer

## Start here

- [CLAUDE.md](CLAUDE.md) — project-wide invariants and architecture
- Approved phased plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-idempotent-oasis.md`
- Zone contracts: [src/core/CLAUDE.md](src/core/CLAUDE.md), [src/server/CLAUDE.md](src/server/CLAUDE.md), [src/client/CLAUDE.md](src/client/CLAUDE.md)
- Lessons learned: [docs/LESSONS.md](docs/LESSONS.md)

## Scripts

```
pnpm install         # install deps
pnpm typecheck       # tsc -b across all three projects
pnpm lint            # eslint with boundary enforcement
pnpm test            # vitest unit
pnpm bench           # vitest bench
pnpm e2e             # playwright
pnpm build           # server + client production build
pnpm dev:server      # tsx watch server
pnpm dev:client      # vite dev server
```
