/** Minimal RGBA PNG encoder (node zlib) for art-lab previews. */
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Compose frames side by side on a dark ground, each scaled by integer `zoom`. */
export function sheet(frames: Array<{ w: number; h: number; data: Uint8ClampedArray }>, zoom: number, bg = [6, 8, 16]): { w: number; h: number; data: Uint8ClampedArray } {
  const pad = 8;
  const W = frames.reduce((s, f) => s + f.w * zoom + pad, pad);
  const H = Math.max(...frames.map((f) => f.h * zoom)) + pad * 2;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = bg[0]!; out[i * 4 + 1] = bg[1]!; out[i * 4 + 2] = bg[2]!; out[i * 4 + 3] = 255; }
  let x0 = pad;
  for (const f of frames) {
    for (let y = 0; y < f.h * zoom; y++) {
      for (let x = 0; x < f.w * zoom; x++) {
        const s = (Math.floor(y / zoom) * f.w + Math.floor(x / zoom)) * 4;
        const a = f.data[s + 3]! / 255;
        const d = ((y + pad) * W + x0 + x) * 4;
        for (let c = 0; c < 3; c++) out[d + c] = f.data[s + c]! * a + out[d + c]! * (1 - a);
      }
    }
    x0 += f.w * zoom + pad;
  }
  return { w: W, h: H, data: out };
}
