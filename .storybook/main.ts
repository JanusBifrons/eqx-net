import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

/**
 * Storybook for in-isolation UI / visual-language work (e.g. the entity badges).
 * Dev-only — never part of the runtime bundle, so no boundary / tech-matrix /
 * netgate impact. Vite-based to match the app toolchain.
 */
const config: StorybookConfig = {
  stories: ['../src/client/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(cfg) {
    // Storybook inherits the app's vite.config; strip app-only concerns that
    // don't apply to isolated components — the PWA service-worker generation
    // (breaks the SB preview build) and the dev proxies to the game server
    // (they'd warn/fail with no backend). Flatten first: VitePWA registers a
    // NESTED plugin array, so a top-level filter misses it.
    const flat = (cfg.plugins ?? []).flat(Infinity);
    const plugins = flat.filter((p) => {
      const name = p && typeof p === 'object' && 'name' in p ? String((p as { name?: string }).name) : '';
      return !/pwa|workbox/i.test(name);
    });
    return mergeConfig({ ...cfg, plugins }, { server: { proxy: {} } });
  },
};
export default config;
