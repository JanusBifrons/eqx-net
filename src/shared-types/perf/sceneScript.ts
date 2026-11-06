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
}).strict();

const EndStep = z.object({
  atMs: z.number().min(0).max(600_000),
  action: z.literal('end'),
}).strict();

export const SceneStepSchema = z.discriminatedUnion('action', [SpawnStep, EndStep]);
export const SceneScriptSchema = z.array(SceneStepSchema).min(1).max(64);
export type SceneStep = z.infer<typeof SceneStepSchema>;

