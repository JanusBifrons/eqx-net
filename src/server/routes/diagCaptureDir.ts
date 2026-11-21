/**
 * Where diagnostic captures are written (docs/architecture/diagnostic-captures.md).
 * Default `<cwd>/diag/captures`; `EQX_DIAG_DIR` overrides it. The phone lane
 * sets it to its `run/captures/` (docs/ops/phone-link.md) so a play session's
 * evidence sits next to `run/server.log`, not in the served checkout.
 */
import { resolve } from 'node:path';

export function resolveCaptureDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const override = env['EQX_DIAG_DIR'];
  return override ? resolve(override) : resolve(cwd, 'diag', 'captures');
}
