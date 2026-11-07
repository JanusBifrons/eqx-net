/**
 * Which galaxy sectors the server creates at boot (memory, 2026-11-07).
 * Every sector costs a room plus a physics world; a showcase or test server
 * that only uses test rooms needs none of them.
 *
 * `EQX_GALAXY_SECTORS`: unset / empty = all; `none` = none; otherwise a
 * comma list of sector keys (unknown keys are ignored). A sector left out
 * still starts on demand when someone joins it.
 */
export function galaxySectorsToBoot(all: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const v = (env['EQX_GALAXY_SECTORS'] ?? '').trim();
  if (v === '') return [...all];
  if (v === 'none') return [];
  const want = new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((k) => want.has(k));
}
