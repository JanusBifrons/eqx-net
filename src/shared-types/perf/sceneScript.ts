/**
 * Scene script schema (plan prancy-squishing-donut P1): the timed world
 * events a perf-scene room plays. Shared so the catalogue (and the phone perf
 * lab) can be read on both sides; the server's `SceneScriptRunner` plays it.
 */
import { z } from 'zod';
import { isShipKindId } from '../shipKinds.js';

/** Bound per step: the slot pool and the payload guard (S5) both matter. */
export const SCENE_MAX_SPAWN = 64;

const SpawnStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('spawn'),
  tag: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/),
  kind: z.string().refine(isShipKindId, 'unknown ship kind'),
  count: z.number().int().min(1).max(SCENE_MAX_SPAWN),
  x: z.number().finite(),
  y: z.number().finite(),
  spread: z.number().min(0).max(20_000).optional(),
  warpIn: z.boolean().optional(),
  hostile: z.boolean().optional(),
  /** Play this spawn again every `repeatEveryMs` while the repeat's time is
   *  before `repeatUntilMs` (a long soak's reinforcements without one step
   *  per wave; the 64-step seed guard still holds). Repeat `k` uses the tag
   *  `<tag>-r<k>`. */
  repeatEveryMs: z.number().min(1000).max(600_000).optional(),
  repeatUntilMs: z.number().min(0).max(600_000).optional(),
}).strict();

/** RTS fleet perf: `count` PARKED hulls of `kind` owned by the first pilot,
 *  each AI-flown by its wingman brain in `mode` / `stance`. `health` sets the
 *  hulls' hit points (a huge value keeps the fleet size fixed over the window,
 *  like the pilot's `initialHull`). */
const FleetStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('fleet'),
  tag: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/),
  kind: z.string().refine(isShipKindId, 'unknown ship kind'),
  count: z.number().int().min(1).max(SCENE_MAX_SPAWN),
  x: z.number().finite(),
  y: z.number().finite(),
  spread: z.number().min(0).max(20_000).optional(),
  mode: z.enum(['defend', 'hunt']).optional(),
  stance: z.enum(['aggressive', 'defensive', 'holdFire']).optional(),
  health: z.number().positive().max(10_000_000).optional(),
}).strict();

/** Rock cut perf (salvage stream): `count` still rocks of `radius` in a disc,
 *  ids `scene-<tag>-<i>` (`rocks`); a later `rockCut` mines the first `count`
 *  rocks of a tag to a break with the mining laser (the real wear path), so
 *  their wreck pieces are on screen. */
const RocksStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('rocks'),
  tag: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/),
  count: z.number().int().min(1).max(SCENE_MAX_SPAWN),
  x: z.number().finite(),
  y: z.number().finite(),
  spread: z.number().min(0).max(20_000).optional(),
  radius: z.number().min(10).max(400),
}).strict();

const RockCutStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('rockCut'),
  tag: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/),
  count: z.number().int().min(1).max(SCENE_MAX_SPAWN),
}).strict();

const EndStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('end'),
}).strict();

export const SceneStepSchema = z.discriminatedUnion('action', [SpawnStep, FleetStep, RocksStep, RockCutStep, EndStep]);
export const SceneScriptSchema = z.array(SceneStepSchema).min(1).max(64);
export type SceneStep = z.infer<typeof SceneStepSchema>;

