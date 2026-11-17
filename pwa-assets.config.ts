/**
 * PWA icon set from public/pwa-icon.png (`pnpm gen:pwa-assets`).
 * Guide: docs/architecture/web-push.md. The maskable and Apple icons are
 * full-bleed (no padding, background colour fill): the phone crops them to its
 * own shape, so any padding shows as a square inside the circle.
 */
import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

const BG = '#05070f';

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: BG } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: BG } },
  },
  images: ['public/pwa-icon.png'],
});
