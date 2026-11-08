# Host profile (desktop) — 2026-11-08
- CPU: AMD Ryzen 7 9800X3D 8C/16T; RAM 31.1 GB (14.3 GB available at idle); CPU idle 0%
- GPU: NVIDIA RTX 5070 Ti (+ AMD iGPU). Headless Chromium with --use-angle=d3d11 (showcase + perf:scenes) -> "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti ... D3D11)"
- Default Playwright headless (playwright.config.ts, used by e2e) -> SwiftShader (software). channel:'chromium' -> RTX.
- Power plan: Balanced. Background: NZXT CAM, SignalRGB, LGHub, Defender (no exclusion).
- Node v24.14.0, ffmpeg 9.0.2 (libx264, h264_nvenc)
- SHA: 971f5d62 (origin/main, merge of #346) in worktree .claude/worktrees/desktop-verify
- No listeners on 2567/5173/2767/5373 at start.
