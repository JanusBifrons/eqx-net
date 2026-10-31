/**
 * Turns recorded frames into finished video.
 *
 * - `encodeClip`: timestamp-accurate CFR encode (each frame holds until the
 *   next one's capture time, so a dropped frame freezes for a beat instead of
 *   speeding the clip up), cut windows removed, phone shots pillarboxed, caption
 *   lower-third faded in/out, dip from/to black.
 * - `encodeCard`: a still card as a short clip.
 * - `assemble`: concatenates clips (identical encode params ⇒ stream copy) and
 *   writes a 720p preview.
 * - `qaClip`: contact sheet + blank-frame check.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FrameIndex } from './recorder.js';
import { ffmpeg, ffmpegInfo, probeDurationMs } from './tools.js';

export interface EncodeOpts {
  fps: number;
}

const W = 1920;
const H = 1080;
const BG = '0x05070d';
const FADE = 0.35;
const X264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/** Build an ffconcat list from the frame index, skipping cut windows. Returns total seconds. */
export function writeConcatList(
  clipDir: string,
  index: FrameIndex,
  durationMs: number,
  cuts: ReadonlyArray<{ fromMs: number; toMs: number }> = [],
): number {
  const inCut = (t: number): boolean => cuts.some((c) => t >= c.fromMs && t < c.toMs);
  const keep = index.frames.filter((f) => !inCut(f.t));
  const lines = ['ffconcat version 1.0'];
  let total = 0;
  for (let i = 0; i < keep.length; i++) {
    const cur = keep[i]!;
    let next = i + 1 < keep.length ? keep[i + 1]!.t : durationMs;
    // A cut between this frame and the next: hold this frame for one beat only.
    if (cuts.some((c) => c.fromMs >= cur.t && c.fromMs < next)) next = cur.t + 1000 / 30;
    const d = Math.max(1, next - cur.t) / 1000;
    total += d;
    lines.push(`file '${cur.file}'`, `duration ${d.toFixed(4)}`);
  }
  if (keep.length > 0) lines.push(`file '${keep[keep.length - 1]!.file}'`);
  writeFileSync(path.join(clipDir, 'frames.ffconcat'), lines.join('\n'));
  return total;
}

export async function encodeClip(
  clipDir: string,
  index: FrameIndex,
  durationMs: number,
  captionPng: string | null,
  opts: EncodeOpts & { cuts?: ReadonlyArray<{ fromMs: number; toMs: number }> },
): Promise<string> {
  const out = path.join(clipDir, 'clip.mp4');
  const total = writeConcatList(clipDir, index, durationMs, opts.cuts);
  const fadeOut = Math.max(0, total - FADE);
  const base =
    `[0:v]fps=${opts.fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1,format=yuv420p,` +
    `fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOut.toFixed(3)}:d=${FADE}`;
  const args = ['-f', 'concat', '-safe', '0', '-i', path.join(clipDir, 'frames.ffconcat')];
  let filter: string;
  if (captionPng) {
    const capIn = 0.6;
    const capOut = Math.max(capIn + 1, total - 1.0);
    args.push('-loop', '1', '-i', captionPng);
    filter =
      `${base}[v];[1:v]format=rgba,fade=t=in:st=${capIn}:d=0.5:alpha=1,` +
      `fade=t=out:st=${capOut.toFixed(3)}:d=0.5:alpha=1[c];[v][c]overlay=0:0:shortest=1,format=yuv420p[o]`;
  } else {
    filter = `${base}[o]`;
  }
  await ffmpeg([...args, '-filter_complex', filter, '-map', '[o]', '-t', total.toFixed(3), '-r', String(opts.fps), ...X264, out]);
  return out;
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
