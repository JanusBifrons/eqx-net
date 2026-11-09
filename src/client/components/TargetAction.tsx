/**
 * Fire control (exp/fire-control) — the inspector's "Target" button: lock the
 * selected ship / drone / structure with the ACTIVE weapon group, so the pilot
 * doesn't have to track it with the smart-aim drag. Drawn in the active
 * group's colour (the same colour its lock brackets will be). Shown only for a
 * fire-control pilot, for something lockable that isn't theirs.
 */
import Box from '@mui/material/Box';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { groupColourHex } from '../hud/groupColours';

const LOCKABLE = new Set(['ship', 'drone', 'structure']);

export function TargetAction({ isOwn }: { isOwn: boolean }): JSX.Element | null {
  const kind = useUIStore((s) => s.selectedEntityKind);
  const selected = useUIStore((s) => s.selectedEntityId);
  const groups = useUIStore((s) => s.fcGroups);
  const active = useUIStore((s) => s.activeGroupId);
  const client = getGameClient();
  if (!client?.isFireControl?.() || isOwn || selected === client.mirror.localPlayerId || kind === null || !LOCKABLE.has(kind)) return null;
  const idx = groups.findIndex((g) => g.id === active);
  if (idx < 0) return null;
  const col = groupColourHex(idx);
  const group = groups[idx]!;
  const key = selected === null ? null : selected.startsWith('swarm-') ? `s:${selected.slice(6)}` : `p:${selected}`;
  const lock = key === null ? undefined : group.locks.find((l) => l.target === key);
  const state = lock === undefined ? 'lock' : lock.stage === 2 ? 'unlock' : 'cancel';
  const onClick = (): void => {
    const c = getGameClient();
    if (!c) return;
    if (state === 'lock') c.lockSelected();
    else if (key !== null) c.cancelLock(group.id, key);
  };
  return (
    <Box
      component="button"
      data-testid="fc-target"
      data-group={active ?? ''}
      data-state={state}
      onClick={onClick}
      sx={{
        pointerEvents: 'auto',
        mt: 0.5,
        px: 1,
        py: 0.25,
        minHeight: 26,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        color: col,
        background: 'rgba(6,10,20,.75)',
        border: `1px solid ${col}`,
        borderRadius: 0.5,
        cursor: 'pointer',
      }}
    >
      {state === 'lock' ? `LOCK · ${group.name.toUpperCase()}` : state === 'cancel' ? 'CANCEL LOCK' : `UNLOCK · ${group.name.toUpperCase()}`}
    </Box>
  );
}
