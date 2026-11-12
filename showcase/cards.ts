/**
 * Title / section / end cards and caption lower-thirds, rendered as HTML and
 * screenshotted by Playwright (system fonts — nothing to bundle or license,
 * and no ffmpeg drawtext escaping). Captions render with a transparent
 * background for overlay.
 */
import type { Browser } from '@playwright/test';
import { CAPTION_DEFAULT_BOTTOM } from './captionPlacement.js';

const W = 1920;
const H = 1080;

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; font-family: 'Segoe UI', 'Inter', system-ui, sans-serif; color: #e8f3ee; }
  .accent { color: #00f58a; }
  .mono { font-family: Consolas, 'JetBrains Mono', monospace; }
`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function shoot(browser: Browser, html: string, out: string, transparent: boolean): Promise<void> {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: out, omitBackground: transparent });
  await page.close();
}

const CARD_BG = `background: radial-gradient(ellipse at 50% 40%, #0b1a16 0%, #05070d 70%);`;

export async function titleCard(browser: Browser, out: string, sub: string): Promise<void> {
  await shoot(
    browser,
    `<style>${BASE_CSS} body{${CARD_BG} display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
      h1{font-family:Consolas,monospace;font-size:132px;letter-spacing:28px;color:#00f58a;text-shadow:0 0 40px #00f58a66}
      p{font-size:30px;letter-spacing:12px;color:#8fb3a6;text-transform:uppercase}</style>
     <body><h1>EQX PERI</h1><p>${esc(sub)}</p></body>`,
    out,
    false,
  );
}

export async function sectionCard(browser: Browser, out: string, title: string, sub: string): Promise<void> {
  await shoot(
    browser,
    `<style>${BASE_CSS} body{${CARD_BG} display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
      h2{font-size:84px;font-weight:300;letter-spacing:6px}
      .rule{width:120px;height:3px;background:#00f58a}
      p{font-size:28px;color:#8fb3a6;max-width:1100px;text-align:center;line-height:1.5}</style>
     <body><div class="rule"></div><h2>${esc(title)}</h2><p>${esc(sub)}</p></body>`,
    out,
    false,
  );
}

export async function endCard(browser: Browser, out: string, lines: string[], sha: string, date: string): Promise<void> {
  const items = lines.map((l) => `<li>${esc(l)}</li>`).join('');
  await shoot(
    browser,
    `<style>${BASE_CSS} body{${CARD_BG} display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px}
      h1{font-family:Consolas,monospace;font-size:72px;letter-spacing:16px;color:#00f58a}
      ul{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:16px 64px;font-size:26px;color:#cfe4dc}
      li::before{content:'▸ ';color:#00f58a}
      .meta{font-size:20px;color:#5f7d72}</style>
     <body><h1>EQX PERI</h1><ul>${items}</ul><div class="meta mono">snapshot ${esc(sha)} · ${esc(date)}</div></body>`,
    out,
    false,
  );
}

/**
 * Caption overlay (transparent PNG). `lower-third` for landscape footage;
 * `side` sits in the left margin beside a pillarboxed phone (the phone frame
 * occupies the centre ~500 px, so a lower-third would cover it).
 */
export async function captionOverlay(
  browser: Browser,
  out: string,
  title: string,
  caption: string,
  layout: 'lower-third' | 'side' | 'top' = 'lower-third',
  /** Lower-third only: CSS `bottom` of the box, from `captionPlacement`
   *  (above the game's bottom HUD in a spectator take). */
  bottomPx: number = CAPTION_DEFAULT_BOTTOM,
): Promise<void> {
  // `top`: a compact one-block caption in the band above a landscape phone
  // frame (`compositor.deviceLayout` leaves ~150 px there).
  const place =
    layout === 'side'
      ? 'left:96px;top:50%;transform:translateY(-50%);max-width:540px;'
      : layout === 'top'
        ? 'left:50%;top:22px;transform:translateX(-50%);max-width:1500px;padding:12px 24px 14px !important;'
        : `left:72px;bottom:${bottomPx}px;max-width:1150px;`;
  const compact = layout === 'top' ? '.t{font-size:18px;margin-bottom:4px}.c{font-size:24px;white-space:nowrap}' : '';
  await shoot(
    browser,
    `<style>${BASE_CSS} html,body{background:transparent}
      .box{position:absolute;padding:20px 28px 22px;${place}
        background:linear-gradient(90deg,rgba(3,8,10,.82),rgba(3,8,10,.55));border-left:4px solid #00f58a;border-radius:4px}
      .t{font-size:22px;letter-spacing:5px;text-transform:uppercase;color:#00f58a;margin-bottom:8px}
      .c{font-size:32px;line-height:1.35;color:#eef8f3}${compact}</style>
     <body><div class="box"><div class="t">${esc(title)}</div><div class="c">${esc(caption)}</div></div></body>`,
    out,
    true,
  );
}

/**
 * Device frame overlay for a phone take (1920×1080 PNG): the background, a
 * dark bezel with a soft rim highlight and a camera dot, and a TRANSPARENT
 * rounded screen the footage shows through. One element does the cut-out: a
 * transparent box whose border is the bezel (inner radius = screen radius) and
 * whose huge spread shadow paints everything outside the device.
 */
export async function deviceFrame(
  browser: Browser,
  out: string,
  layout: { screen: { x: number; y: number; w: number; h: number }; bezel: number; radius: number; orientation: 'portrait' | 'landscape' },
): Promise<void> {
  const { screen: s, bezel: b, radius: r } = layout;
  const outer = r + b;
  const dev = `left:${s.x - b}px;top:${s.y - b}px;width:${s.w + 2 * b}px;height:${s.h + 2 * b}px;border-radius:${outer}px;`;
  // Camera dot in the bezel: top-centre in portrait, left-middle in landscape.
  const cam =
    layout.orientation === 'portrait'
      ? `left:${s.x + s.w / 2 - 5}px;top:${s.y - b / 2 - 5}px;`
      : `left:${s.x - b / 2 - 5}px;top:${s.y + s.h / 2 - 5}px;`;
  await shoot(
    browser,
    `<style>${BASE_CSS} html,body{background:transparent}
      .dev{position:absolute;${dev}box-sizing:border-box;border:${b}px solid #14171c;
        box-shadow:0 0 0 4000px #05070d, inset 0 0 0 1px rgba(0,0,0,.9)}
      .rim{position:absolute;${dev}box-sizing:border-box;border:1.5px solid rgba(190,215,205,.16);
        box-shadow:0 0 60px rgba(0,245,138,.05)}
      .cam{position:absolute;${cam}width:10px;height:10px;border-radius:50%;
        background:radial-gradient(circle at 35% 35%,#2a3340,#07090c 70%);box-shadow:0 0 0 1px rgba(255,255,255,.06)}</style>
     <body><div class="dev"></div><div class="rim"></div><div class="cam"></div></body>`,
    out,
    true,
  );
}
