/**
 * Server → client wave-system HUD messages: the sector-wide warp-in warning
 * banner and the one-shot "base operational" alert. zod-validated (#3);
 * purity-clean — discrete UI values only, no positions reach Zustand (#2).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { useUIStore } from '../../state/store';
import { ServerMessageSchemas } from '@shared-types/messages';

/** What the wave handlers touch: the mirror (read for the local player id). */
export interface WaveHandlerCtx {
  readonly mirror: RenderMirror;
}

export function registerWaveHandlers(room: Room, ctx: WaveHandlerCtx): void {
  const mirror = ctx.mirror;

  // Wave-system Phase 5 — sector-wide warp-in warning HUD. Drives visible UI,
  // so we zod-validate + drop malformed packets (invariant #3) — a bad
  // count/countdownMs would render a garbage banner. Purity-clean: no
  // positions reach Zustand (invariant #2).
  room.onMessage('warp_warning', (raw: unknown) => {
    const parsed = ServerMessageSchemas.warp_warning.safeParse(raw);
    if (!parsed.success) return;
    const { id, label, count, countdownMs, disposition } = parsed.data;
    // Phase-4 P0 — colour the banner by the inbound's relation. The wire speaks
    // `enemy`/`neutral`/`friendly`; the store/banner speak `hostile`/`neutral`/
    // `friendly`. Absent ⇒ store default (hostile), back-compat with old servers.
    const relation =
      disposition === 'enemy'
        ? 'hostile'
        : disposition === 'friendly'
          ? 'friendly'
          : disposition === 'neutral'
            ? 'neutral'
            : undefined;
    useUIStore.getState().addWarpWarning({ id, label, count, countdownMs, ...(relation ? { relation } : {}) });
  });
  room.onMessage('warp_warning_clear', (raw: unknown) => {
    const parsed = ServerMessageSchemas.warp_warning_clear.safeParse(raw);
    if (!parsed.success) return;
    useUIStore.getState().removeWarpWarning(parsed.data.id);
  });

  // WS-11 (R2.24 Part B) — one-shot "your base is operational" toast the first
  // time the local player's base qualifies for waves. Broadcast to the whole
  // sector; OWNER-ONLY (it's a personal base milestone). Reuses the transient
  // `sectorAlert` HUD line (the existing toast mechanism). zod-validated
  // (invariant #3); purity-clean (a discrete string, no spatial field, #2).
  room.onMessage('base_ready', (raw: unknown) => {
    const parsed = ServerMessageSchemas.base_ready.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.factionId !== mirror.localPlayerId) return;
    const msg = '⚔ Base operational — defend against incoming waves';
    useUIStore.getState().setSectorAlert(msg);
    // Auto-clear after ~6 s, but only if it's still OUR message (don't clobber
    // a newer alert set in the meantime).
    window.setTimeout(() => {
      if (useUIStore.getState().sectorAlert === msg) useUIStore.getState().setSectorAlert(null);
    }, 6000);
  });
}
