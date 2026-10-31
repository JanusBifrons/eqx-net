/**
 * Showcase pipeline — shot contract (docs/architecture/showcase-pipeline.md).
 *
 * A shot is DATA plus small async hooks. The recorder drives it in a real
 * browser against an isolated server; the compositor turns the frames into a
 * captioned clip. Adding a feature to the video = adding one file in `shots/`.
 */
import type { Page } from '@playwright/test';
import type { CameraCue } from '../src/core/contracts/cameraScript.js';

/** Which server boot a shot needs. Shots are recorded grouped by profile. */
export type ServerProfile =
  /** Living world OFF — engineering/showcase rooms. Fastest, most stable. */
  | 'lean'
  /** Living world ON — galaxy sectors with roaming squads. */
  | 'living'
  /** Living world ON + the wave E2E base (`EQX_E2E_WAVE=1`, fast bot spool). */
  | 'wave';

export type HudMode = 'full' | 'clean' | 'minimal' | 'none';

export type Section = 'opener' | 'mechanics' | 'tech';

export interface ShotTarget {
  /** Engineering/showcase room name (`?room=`). */
  room?: string;
  /** Galaxy sector key (`?galaxy=`). */
  galaxy?: string;
  /** The galaxy landing page (no room). */
  landing?: boolean;
  /** Extra URL params (shipKind, startHostile, initialHull, zoom, ...). */
  params?: Record<string, string | number>;
}

/** Everything a shot hook can use. */
export interface ShotContext {
  page: Page;
  /** Vite origin, e.g. http://localhost:5373 */
  baseUrl: string;
  /** Colyseus HTTP origin, e.g. http://127.0.0.1:2767 */
  serverUrl: string;
  /** Unique per take — isolates `filterBy(['testId'])` rooms. */
  testId: string;
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
  /** Hold keys down for `ms` (e.g. ['w', 'a']). */
  hold(keys: string[], ms: number): Promise<void>;
  cinema: {
    play(cues: CameraCue[]): Promise<void>;
    stop(): Promise<void>;
    hud(mode: HudMode): Promise<void>;
  };
  /** Restart the server with the same DB (persistence shot). */
  restartServer(): Promise<void>;
  /** Navigate to a target and wait until in-game (or landing ready). */
  enter(target: ShotTarget): Promise<void>;
}

export interface Shot {
  /** Stable id — file name, clip name, `--shot <id>`. */
  id: string;
  section: Section;
  /** Card / lower-third title. */
  title: string;
  /** One-line caption burned into the clip. */
  caption: string;
  /** Feature-inventory ids this shot demonstrates (M1, U4, T2, ...). */
  features: string[];
  /** Feature/architecture doc basenames this shot covers (coverage lock). */
  docs: string[];
  /** In the ~3 min reel, or catalogue-only. */
  reel: boolean;
  server: ServerProfile;
  target: ShotTarget;
  /** HUD while recording (default 'minimal'). */
  hud?: HudMode;
  viewport?: 'desktop' | 'phone';
  /** Log in with the dev test-token account first (default true). */
  auth?: boolean;
  /** Seed localStorage before load (e.g. the wave base owner id). */
  storage?: Record<string, string>;
  /** Runs after entering, before recording starts (unrecorded). */
  prepare?(ctx: ShotContext): Promise<void>;
  /** Resolve to start recording (event-driven takes). Default: start now. */
  startWhen?(ctx: ShotContext): Promise<void>;
  /** Recorded length. */
  durationMs: number;
  /** Camera script, started when recording starts. */
  camera?: CameraCue[];
  /** Actions during recording; must finish within `durationMs`. */
  run?(ctx: ShotContext): Promise<void>;
  /** Cut these windows out in the edit (e.g. the 30 s warp spool). */
  cuts?: Array<{ fromMs: number; toMs: number; label: string }>;
}

/** Per-clip record written to `showcase-out/manifest.json`. */
export interface ClipRecord {
  id: string;
  sha: string;
  recordedAt: string;
  frames: number;
  durationMs: number;
  deliveredFps: number;
  gapP95Ms: number;
  gapMaxMs: number;
  /** QA verdict; failed clips are flagged for a re-take, never silently used. */
  qa: { ok: boolean; problems: string[] };
}
