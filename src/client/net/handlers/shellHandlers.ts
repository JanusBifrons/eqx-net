/**
 * Server → client drawn-shell events (shell-events.md): salvo + end records
 * feed the shell store / per-shell timing; `shell_blast` queues a siege
 * burst's explosion VFX. The store stays owned by `ColyseusClient` (the frame
 * path reads it); this file only receives a reference.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { ServerMessageSchemas } from '@shared-types/messages';
import type { ShellEnd } from '@shared-types/messages/shellEvents';
import { ShellBlastSchema } from '@shared-types/shellBlast';
import type { ShellSalvoStore } from '../shellSalvoStore.js';

/** What the shell handlers touch: the mirror, the shell store, the welcome's
 *  shells-as-events flag and the `shell_end` sink (`DrawnShellTiming`). */
export interface ShellHandlerCtx {
  readonly mirror: RenderMirror;
  readonly shellStore: ShellSalvoStore;
  readonly shellEvents: () => boolean;
  readonly applyShellEnd: (msg: ShellEnd) => void;
}

export function registerShellHandlers(room: Room, ctx: ShellHandlerCtx): void {
  const { mirror, shellStore, shellEvents, applyShellEnd } = ctx;

  // Shells as events (shell-events.md slice 2a): salvo + hit records.
  room.onMessage('shell_salvo', (raw: unknown) => {
    if (!shellEvents()) return;
    const r = ServerMessageSchemas.shell_salvo.safeParse(raw);
    if (r.success) shellStore.applySalvo(r.data);
  });
  room.onMessage('shell_end', (raw: unknown) => {
    if (!shellEvents()) return;
    const r = ServerMessageSchemas.shell_end.safeParse(raw);
    if (r.success) applyShellEnd(r.data);
  });
  // Coastal defences — a siege shell burst: the same explosion visual, at
  // the size of its blast (the damage arrives as damage events).
  room.onMessage('shell_blast', (raw: unknown) => {
    const result = ShellBlastSchema.safeParse(raw);
    if (!result.success) return;
    (mirror.pendingMissileExplosions ??= []).push({
      x: result.data.x,
      y: result.data.y,
      splashRadius: result.data.radius,
      missileId: -1,
    });
  });
}
