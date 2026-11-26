/**
 * Browser-context options for a spec that renders on the MAIN thread
 * (`?worker=0`) and waits on the renderer (frames, draw stats, clicks on drawn
 * hulls).
 *
 * CI has no GPU: Chromium draws with SwiftShader (software WebGL), and on the
 * main-thread renderer every rasterised pixel blocks the page. At the Desktop
 * Chrome 1280x720 at DPR 1 a Machined-art scene costs 100-500 ms a frame there
 * (the scene work itself is 1-5 ms), so input, `page.evaluate` and the
 * client's fire/lock loop crawl and renderer waits time out.
 *
 * Half the device scale factor renders a 640x360 backbuffer: a quarter of the
 * fill. Layout, camera, zoom and LOD follow the CSS size, so what is drawn
 * (and every count and screen point a spec reads: `__eqxWorldToScreen` is in
 * CSS px) is unchanged. The same trick keeps `pnpm perf:counts` fast on
 * software GL (perf/run-counts.ts `DEVICE_SCALE`).
 *
 * Reproduce CI's GL locally with `EQX_E2E_SOFTWARE_GL=1` (playwright.config.ts).
 */
export const MAIN_THREAD_RENDER_CONTEXT = { deviceScaleFactor: 0.5 } as const;
