# Agent workflow: commits, clean-up, PRs, worktrees and ports

Root `CLAUDE.md` keeps the short form of each standing rule below; this page holds the full text, the commands and the reasons. Read it when you open a PR, clean up after a run, plan a feature that touches an existing system, or start a server.

## Compact, don't relaunch

The owner tracks every stream by its session window and name, often from the phone. A stream therefore stays in ONE session for its whole life; it never hands off to a fresh session.

- **Compaction in place.** On this machine Claude Code compacts a session in place at ~250k tokens: user settings `autoCompactWindow: 250000`.
- **Before compaction.** A `PreCompact` hook (`~/.claude/hooks/precompact.js`) tells the summary to keep:
  - the stream and its plan file;
  - the current slice;
  - open PRs, branches and worktrees;
  - running background agents and what each is doing;
  - the owner's decisions;
  - the handoff file and the next step.
- **After compaction.** A `SessionStart` hook with the `compact` matcher (`~/.claude/hooks/session-compact.js`) tells the session to re-read its handoff and memory before acting.
- **The session's job.** Keep `.resume/<slug>.md` current at every milestone, so the summary and the handoff agree.
- **The reminder.** `scripts/dev/context-nudge.mjs` (a project PostToolUse hook) reminds the session at 250k and 400k.
- **Limit.** Claude Code cannot start a fresh session or `/clear` itself. The `eqx-resume` launcher stays for relaunching parked streams after a reboot.

## Commit cadence

Commit at every milestone where the inner loop (`pnpm typecheck && pnpm lint && pnpm test`) is green and the change is a coherent unit, usually one plan step per commit, subject in the imperative with the plan reference. Group only related changes. Never commit yellow code to save progress; `--no-verify` is forbidden. Before a session ends, `git status` is clean or the pending work is noted.

## Clean up at every stage (standing user directive)

"Clean up as much memory as you can at each stage" (a plan step, a commit, a test/netgate/showcase run, the session end):
1. **RAM / processes:** when a run finishes, and before EVERY recording (showcase take, perf scene), stop what this session started (dev 2567/5173, showcase 2767/5373, netgate vite/proxies, headless Chrome, ffmpeg, `tsx watch`; never the user's own Chrome). The recording itself goes through the [heavy-job queue](#heavy-job-queue), which checks free RAM.
2. **Disk:** scratch lives in the session scratchpad, not `diag/_*`; delete it when its stage ends. Remove a `.claude/worktrees/<x>` worktree once its branch is merged and clean (keep `netgate-baseline` / `netgate-head`). Never delete committed evidence or a dirty worktree without asking.
3. **Auto-memory:** keep `MEMORY.md` under 24 KB, one ~150-char line per note; collapse or delete notes when their plan finishes or a later note supersedes them.

## Heavy-job queue

Many sessions share one desktop. When each checked "4 GB free" on its own, they all started heavy work at once, starved each other, and the low-memory reaper killed the jobs: nothing finished. Now ONE heavy job runs at a time, machine-wide; slower, but everything finishes. This replaces the retired `.claude/recording.lock` and the bare RAM check.

- **Heavy (queue it):** showcase take, e2e / netgate run, `pnpm perf:scenes`, the full `pnpm test` suite, an integration batch.
- **Light (never queue):** typecheck, lint, a unit file or single test, a server boot.
- **How:** `pnpm heavy run --kind <film|e2e|netgate|perf|suite|other> [--priority 1-5] [--minutes <estimate>] [--who <label>] -- <command…>`. The wrapper joins the queue, waits until it is first, nothing else runs and free RAM ≥ 4 GB (`HEAVY_QUEUE_MIN_GB`), then runs the command with your stdio and returns its exit code. Its ticket and slot are removed on exit, Ctrl+C or crash; a ticket whose process died is swept by any waiter. No live job is ever killed.
- **Run it with `run_in_background`.** A wait can exceed the 10-min foreground tool timeout; you are notified when it exits. While waiting it prints one line every 30 s (position, who runs, waited, free RAM).
- **See the queue:** `pnpm heavy status` (`--json` for tools). Tickets live in `<main checkout>/.claude/heavy-queue/`, shared by every worktree.
- **Priorities:** owner waiting on a film = 5; CI-blocking rerun = 4; default = 3; background perf / exploratory = 2; 1 = whenever. Waiting raises priority by 1 per 10 min, so nothing starves. Order: highest priority, then oldest.
- **Subagent briefs repeat the rule** (a subagent does not see this page).

Examples:

```sh
pnpm heavy run --kind film --priority 5 --minutes 12 --who weapon-cuts -- pnpm showcase --shot "fc-*"
pnpm heavy run --kind netgate --priority 4 --minutes 20 -- pnpm e2e:netgate
pnpm heavy run --kind perf --priority 2 --minutes 30 -- pnpm perf:scenes --base origin/main
pnpm heavy status
```

## NEVER build a parallel system (standing user directive)

Owner: "NEVER build a parallel system." When a feature needs something the game already does (AI pilots and tactics, ship drawing, an entity type, a fire path, a UI surface), EXTEND that system with the hooks it needs. Never write a sibling next to it, however much easier or "safer for its tests" that looks. (A sibling `WingmanBehaviour` once lacked the NPC dogfight work and drew ships differently; the owner had never been asked.)

**Every plan gets a hostile review for parallel systems, then the owner is ASKED:**
1. Before a plan is presented or building starts, a separate hostile reviewer agent gets the plan and the codebase (not your conclusion). For each new module / class / behaviour / renderer / message, it names the existing system that already does that job and says whether the plan extends or duplicates it.
2. Any duplicate is a blocker: rewrite the plan to extend the existing system.
3. If a sibling really seems necessary, ask the owner with AskUserQuestion in plain words ("the game already has X; I want to build a second Y because Z — OK?") BEFORE any code. Never decide it yourself or bury it in a plan file.
4. Subagent briefs say the same: "extend existing systems; if you think a new parallel one is needed, stop and report instead".

## End every message with a status line (standing user directive)

The last line of every message is **Continuing:** (what happens next), **Done:** (nothing left) or **Waiting on you:** (a short pointer to the decision).

- **Never end a turn to wait for "continue".** When a plan is approved, execute ALL of it: commit, push, PR (auto-merge) each piece, then start the next piece in the same turn. A phase boundary, an in-flight PR (branch off it) or the size of what's left is not a reason to stop; stop only when the plan is done, for a genuine user decision, or a hard blocker.
- **Pending CI or a long run is not a reason to stop:** start the next independent item meanwhile, in a second worktree or port lane.
- **Decisions go through the AskUserQuestion tool, never as questions in prose.**

## Pushing branches & opening PRs

`gh` is installed and fully authed (user PATH; `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe`). Never leave finished, green work unpushed.

```
git fetch origin && git checkout -b <branch> origin/main      # every new branch
git fetch origin && git merge --no-edit origin/main            # right before push; re-run the inner loop
git push -u origin <branch>
gh pr create --base main --head <branch> --title "…" --body-file <scratchpad>/pr-body.md
gh pr merge <n> --auto --merge                                 # ALWAYS, the instant the PR exists
```

- **Auto-merge is part of opening a PR (standing user directive):** `--auto` holds the PR until required CI passes, so it is safe. Report "auto-merge on" with the PR URL.
- **Sync once, then leave it:** merge `origin/main` once right before the first push. The ruleset does NOT require branches to be up to date, and every merge to `main` reruns the full suite, so do not re-sync a branch just because it is behind (each re-sync reruns CI and piles PRs up). Re-sync only when the PR shows a conflict (`gh pr view <n> --json mergeStateStatus` = `DIRTY`) or you need code that landed since. Use `git merge`, not rebase, on a pushed branch.
- **Auto-memory is per machine; the user works on two.** Machine-specific facts may go in a memory; any rule, convention or project gotcha goes in the repo (a rule in CLAUDE.md, anything else in `docs/`). When in doubt, put it in the repo.
- If gh auth breaks: `gh auth refresh -h github.com -s read:org` in PowerShell / Windows Terminal (not Git Bash; there prefix `winpty`).

## Verification Protocol (after every server-touching change)

Boot the server before reporting success: `timeout 8 pnpm dev:server`. A clean boot prints `INFO: EQX Peri server started port: 2567`; exit 143 is the normal SIGTERM, anything else means the change broke the runtime (decorator transforms, `Symbol.metadata`, ESM resolution) even if typecheck passes. If 2567 is taken, check its owner (next section): stop it only if this session started it; otherwise boot on offset ports.

## Work in a worktree; check port owners before using a port (standing user directive)

Several Claude sessions run on this machine at once. So:

- **All work happens in a git worktree** under `.claude/worktrees/<name>` on its own branch, never in the main checkout.
- **Before starting, using or opening any port, check who owns it** (`netstat -ano | findstr LISTENING | findstr ":<port>"`, then the PID's command line). Stop only processes your session started (match the worktree path in the command line); another session's server is never yours to kill, even on the canonical ports.
- **Check immediately before launching, not in parallel with the launch.** When another session is active, prefer offset ports (`EQX_E2E_PORT_OFFSET`, `EQX_SHOWCASE_PORT_OFFSET`, `NETGATE_PORT_OFFSET`, or `PORT=` + `EQX_SERVER_PORT=` + `vite --port … --strictPort`).

## Stale dev servers cause "phantom" E2E failures

- Playwright reuses whatever listens on 2567/5173 (`reuseExistingServer: true`), and a stale server runs old code: a flood of `boot.spec.ts` timeouts means a stale server, not a broken spec.
- Before a server boot or E2E run, stop the servers on those ports that THIS session or worktree started (worktree path in the PID's command line), then boot fresh; don't dodge onto `PORT=2568` with your own leftover still running. Another session's server is never yours: use an offset lane (`EQX_E2E_PORT_OFFSET`) instead.
- Keep `reuseExistingServer: true`; for a diagnostic loop set `CI=1` so Playwright spawns a fresh server. Commands and detail: [docs/architecture/e2e-framework.md](../architecture/e2e-framework.md) "Running E2E specs".
