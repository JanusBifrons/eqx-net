/**
 * Turns recorded frames into finished video.
 *
 * - `encodeClip`: timestamp-accurate CFR encode (each frame holds until the
 *   next one's capture time, so a dropped frame freezes for a beat instead of
 *   speeding the clip up), cut windows removed, phone shots framed in a device bezel, caption
 *   lower-third faded in/out, dip from/to black.
 * - `encodeCard`: a still card as a short clip.
 * - `assemble`: concatenates clips (identical encode params ⇒ stream copy) and
 *   writes a 720p preview.
 * - `qaClip`: contact sheet + blank-frame check.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FrameIndex } from './recorder.js';
import type { ShotViewport } from './types.js';
import { ffmpeg, ffmpegInfo, probeDurationMs, resolveFfmpeg, run } from './tools.js';
import { perSecond, slotsKept } from './cadence.js';

export interface EncodeOpts {
  fps: number;
}

/** A phone take's place on the 1920×1080 output: the screen rect the frames
 *  scale into, and the bezel drawn around it (see `cards.deviceFrame`). */
export interface DeviceLayout {
  /** Screen rect on the output (even numbers: safe for yuv420 chroma). */
  screen: { x: number; y: number; w: number; h: number };
  /** Bezel thickness around the screen, px. */
  bezel: number;
  /** Screen corner radius, px (the bezel's outer radius adds `bezel`). */
  radius: number;
  orientation: 'portrait' | 'landscape';
}

const even = (n: number): number => Math.round(n / 2) * 2;

/**
 * Where a phone take sits on the output. Portrait: a tall device centred
 * (side caption in the left margin). Landscape: a wide device centred with a
 * ~150 px band above it for the `top` caption. Desktop takes fill the frame
 * (null). `aspect` = the take's CSS width / height.
 */
export function deviceLayout(viewport: ShotViewport, aspect: number): DeviceLayout | null {
  if (viewport === 'desktop') return null;
  if (viewport === 'phone') {
    const h = 968;
    const w = even(h * aspect);
    return { screen: { x: even((W - w) / 2), y: even((H - h) / 2), w, h }, bezel: 18, radius: 34, orientation: 'portrait' };
  }
  const w = 1600;
  const h = Math.min(even(w / aspect), 780);
  // Sit slightly low so the top caption band is a little taller than the bottom margin.
  const y = even((H - h) / 2 + 12);
  return { screen: { x: even((W - w) / 2), y, w, h }, bezel: 20, radius: 40, orientation: 'landscape' };
}

/** x264 rate control: quality-only by default; with a cap, CRF 20 under a VBV ceiling. */
export function x264Args(maxBitrateKbps?: number): string[] {
  if (!maxBitrateKbps) return X264;
  return [
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-maxrate', `${maxBitrateKbps}k`, '-bufsize', `${maxBitrateKbps * 2}k`,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ];
}

const W = 1920;
const H = 1080;
const BG = '0x05070d';
const FADE = 0.35;
/** One 60 Hz display refresh: the game draws one frame per refresh. */
const SLOT_MS = 1000 / 60;
/**
 * The rate the concat demuxer reads each frame at (its time base 1/this).
 * Without it ffmpeg's image demuxer reads a JPEG at 25 fps, so every 1/60 s
 * duration rounded to 0 or 40 ms and `fps=60` kept ~25 different frames a
 * second in a 2/3-slot judder, while QA said 60 (bug 2026-11-10, see
 * `cadence.ts`). Every duration in the list is a whole number of slots.
 */
export const CONCAT_FRAMERATE = 60;
const X264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/** Build an ffconcat list from the frame index, skipping cut windows. Returns total seconds. */
export function writeConcatList(
  clipDir: string,
  index: FrameIndex,
  durationMs: number,
  cuts: ReadonlyArray<{ fromMs: number; toMs: number }> = [],
): number {
  const inCut = (t: number): boolean => cuts.some((c) => t >= c.fromMs && t < c.toMs);
  // Review 2026-11-07 (hostile audit of "still jittery" clips): the game draws
  // one evenly paced frame per 60 Hz display refresh, but CDP screencast
  // timestamps are noisy (p5 13.6 / p95 20.8 ms) and frames can ARRIVE out of
  // order. So: drop frames outside the take (a late frame keeps an epoch
  // time), play in timestamp order, and snap each frame to its nearest 60 Hz
  // slot, one frame per slot, so a frame is held only for slots really
  // missing (a dropped capture frame), never for timestamp noise.
  const keep = index.frames
    .filter((f) => f.t >= 0 && f.t <= durationMs + SLOT_MS && !inCut(f.t))
    .slice()
    .sort((a, b) => a.t - b.t);
  // The capture grid's phase: the circular mean of every timestamp's position
  // within a slot, so frames snap to THEIR refresh, not to a grid at 0.
  let cs = 0, sn = 0;
  for (const f of keep) { const a = ((f.t % SLOT_MS) / SLOT_MS) * Math.PI * 2; cs += Math.cos(a); sn += Math.sin(a); }
  const phase = keep.length ? ((Math.atan2(sn, cs) / (Math.PI * 2) + 1) % 1) * SLOT_MS : 0;
  const slots: Array<{ file: string; t: number; slot: number }> = [];
  for (const f of keep) {
    const slot = Math.round((f.t - phase) / SLOT_MS);
    const prev = slots[slots.length - 1];
    if (prev && slot <= prev.slot) {
      // Two frames in one slot: the next slot is free when the following
      // frame is well past it, else keep the frame nearer this slot's centre.
      if (slot === prev.slot && Math.abs(f.t - phase - slot * SLOT_MS) < Math.abs(prev.t - phase - slot * SLOT_MS)) { prev.file = f.file; prev.t = f.t; }
      continue;
    }
    slots.push({ file: f.file, t: f.t, slot });
  }
  const endSlot = Math.max(1, Math.round((durationMs - phase) / SLOT_MS));
  const lines = ['ffconcat version 1.0'];
  let total = 0;
  for (let i = 0; i < slots.length; i++) {
    const cur = slots[i]!;
    const nextSlot = i + 1 < slots.length ? slots[i + 1]!.slot : Math.max(cur.slot + 1, endSlot);
    let dMs = (nextSlot - cur.slot) * SLOT_MS;
    // A cut between this frame and the next: hold this frame for one beat only.
    if (cuts.some((c) => c.fromMs >= cur.t && c.fromMs < nextSlot * SLOT_MS)) dMs = 1000 / 30;
    const d = dMs / 1000;
    total += d;
    lines.push(`file '${cur.file}'`, `duration ${d.toFixed(6)}`, `option framerate ${CONCAT_FRAMERATE}`);
  }
  if (slots.length > 0) lines.push(`file '${slots[slots.length - 1]!.file}'`, `option framerate ${CONCAT_FRAMERATE}`);
  writeFileSync(path.join(clipDir, 'frames.ffconcat'), lines.join('\n'));
  return total;
}

export async function encodeClip(
  clipDir: string,
  index: FrameIndex,
  durationMs: number,
  captionPng: string | null,
  opts: EncodeOpts & {
    cuts?: ReadonlyArray<{ fromMs: number; toMs: number }>;
    /** Phone takes: scale into this screen rect and overlay `framePng` (the
     *  bezel + background, transparent over the screen). */
    device?: { layout: DeviceLayout; framePng: string } | null;
    maxBitrateKbps?: number;
  },
): Promise<string> {
  const out = path.join(clipDir, 'clip.mp4');
  const total = writeConcatList(clipDir, index, durationMs, opts.cuts);
  const fadeOut = Math.max(0, total - FADE);
  const fades = `fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOut.toFixed(3)}:d=${FADE}`;
  const args = ['-f', 'concat', '-safe', '0', '-i', path.join(clipDir, 'frames.ffconcat')];
  let next = 1;
  let base: string;
  if (opts.device) {
    const s = opts.device.layout.screen;
    args.push('-loop', '1', '-i', opts.device.framePng);
    const fi = next++;
    base =
      `[0:v]fps=${opts.fps},scale=${s.w}:${s.h}:flags=lanczos:out_range=tv,` +
      `pad=${W}:${H}:${s.x}:${s.y}:color=${BG},setsar=1[scr];` +
      `[${fi}:v]format=rgba[bez];[scr][bez]overlay=0:0:shortest=1,format=yuv420p,${fades}`;
  } else {
    base =
      `[0:v]fps=${opts.fps},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1,format=yuv420p,${fades}`;
  }
  let filter: string;
  if (captionPng) {
    const capIn = 0.6;
    const capOut = Math.max(capIn + 1, total - 1.0);
    args.push('-loop', '1', '-i', captionPng);
    const ci = next++;
    filter =
      `${base}[v];[${ci}:v]format=rgba,fade=t=in:st=${capIn}:d=0.5:alpha=1,` +
      `fade=t=out:st=${capOut.toFixed(3)}:d=0.5:alpha=1[c];[v][c]overlay=0:0:shortest=1,format=yuv420p[o]`;
  } else {
    filter = `${base}[o]`;
  }
  await ffmpeg([
    ...args, '-filter_complex', filter, '-map', '[o]', '-t', total.toFixed(3), '-r', String(opts.fps),
    ...x264Args(opts.maxBitrateKbps), out,
  ]);
  return out;
}

/**
 * DIFFERENT frames per second that reach the encode: ffprobe reads the
 * written concat list the way the encode does, and the `fps` filter keeps one
 * frame per output slot. Catches the encode losing frames the capture had
 * (the 2026-11-10 25 fps time-base bug), which the capture counts cannot see.
 */
export async function encodedUniqueFps(clipDir: string, fps: number, durationMs: number): Promise<number> {
  const out = await run(resolveFfmpeg('ffprobe'), [
    '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(clipDir, 'frames.ffconcat'),
    '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0',
  ]);
  const pts = out.split('\n').map((l) => parseFloat(l)).filter((x) => Number.isFinite(x));
  // The last list entry repeats the final frame (concat's end marker).
  return perSecond(slotsKept(pts.slice(0, -1), fps), durationMs);
}

export async function encodeCard(png: string, out: string, seconds: number, opts: EncodeOpts): Promise<string> {
  const vf =
    `scale=${W}:${H},setsar=1,format=yuv420p,fade=t=in:st=0:d=${FADE},` +
    `fade=t=out:st=${(seconds - FADE).toFixed(3)}:d=${FADE}`;
  await ffmpeg(['-loop', '1', '-framerate', String(opts.fps), '-i', png, '-t', String(seconds), '-vf', vf, '-r', String(opts.fps), ...X264, out]);
  return out;
}

export async function assemble(parts: string[], outDir: string, name: string): Promise<{ master: string; preview: string }> {
  const list = path.join(outDir, `${name}.concat.txt`);
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const master = path.join(outDir, `${name}-1080p.mp4`);
  const preview = path.join(outDir, `${name}-720p.mp4`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', master]);
  await ffmpeg(['-i', master, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', preview]);
  return { master, preview };
}

/** Contact sheet (12 frames, 4×3) + blank-frame check (a frame with NOTHING brighter than near-black). */
export async function qaClip(clipMp4: string, sheetOut: string): Promise<{ blankSeconds: number; durationMs: number }> {
  const durationMs = await probeDurationMs(clipMp4);
  const every = Math.max(0.1, durationMs / 1000 / 12);
  await ffmpeg(['-i', clipMp4, '-vf', `fps=1/${every.toFixed(3)},scale=480:-1,tile=4x3:padding=4:color=black`, '-frames:v', '1', sheetOut]);
  // signalstats YMAX per sampled frame (2 fps). Space is dark, so judge by the
  // BRIGHTEST pixel: stars / ships / HUD put YMAX well above black; a truly
  // blank frame stays near 16 (limited-range black). Ignore the fade edges.
  const log = await ffmpegInfo([
    '-i', clipMp4, '-vf', 'fps=2,signalstats,metadata=print:key=lavfi.signalstats.YMAX', '-f', 'null', '-',
  ]);
  const ymax = [...log.matchAll(/YMAX=(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]!));
  const inner = ymax.slice(2, Math.max(2, ymax.length - 2));
  const blankSeconds = inner.filter((y) => y < 40).length / 2;
  return { blankSeconds, durationMs };
}
