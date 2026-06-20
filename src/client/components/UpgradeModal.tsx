import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { getShipKind } from '../../shared-types/shipKinds';
import { LevelBadge } from './LevelBadge';
import {
  STAT_IDS,
  STAT_LABELS,
  toDraft,
  adjustDraft,
  remainingPoints,
  draftToAlloc,
} from './upgradeModalDraft';
import type { RosterShipEntry } from './ShipRosterCard';

/**
 * Ship stat-upgrade modal (Phase 4 WS-B2, plan: effervescent-umbrella). Spend
 * the ship instance's upgrade points (budget = level - 1) FREELY across the
 * stat pool (+max hull, +energy, +damage %, +top speed, +turn rate,
 * +shield/regen), with a respec that refunds every point.
 *
 * Cloned from `ShipDetailModal` (same `xs` Dialog chrome). `keepMounted` (the
 * drawer-perf rule — MUI Modal cold-mount is the dominant first-open cost). The
 * server is the authority: `Apply` sends `apply_ship_upgrade { shipId, alloc }`
 * and `Respec` sends `respec_ship { shipId }`; the physics multipliers re-anchor
 * off the authoritative own-ship snapshot slice, never this modal (risk #1).
 *
 * Stateless about the wire: the parent owns the send callbacks + the close.
 */
interface UpgradeModalProps {
  ship: RosterShipEntry;
  open: boolean;
  onClose: () => void;
  onApply: (shipId: string, alloc: Record<string, number>) => void;
  onRespec: (shipId: string) => void;
  /** Phase 4 WS-B3 — activate a latent weapon mount + bind a weapon to it. */
  onActivateMount?: (shipId: string, slotId: string, weaponId: 'hitscan' | 'laser' | 'heat-seeker') => void;
}

/** Selectable weapons for a freshly-activated mount (WS-B3) — mirrors the
 *  catalogue `MountWeaponIdSchema`. The player picks one per latent slot. */
const MOUNT_WEAPON_CHOICES: ReadonlyArray<{ id: 'hitscan' | 'laser' | 'heat-seeker'; label: string }> = [
  { id: 'laser', label: 'Bolt' },
  { id: 'hitscan', label: 'Beam' },
  { id: 'heat-seeker', label: 'Missile' },
];

export function UpgradeModal({ ship, open, onClose, onApply, onRespec, onActivateMount }: UpgradeModalProps): JSX.Element {
  const kind = getShipKind(ship.kind);
  const level = ship.level ?? 1;
  // Server-authoritative current allocation, re-synced whenever the modal opens
  // or the ship's persisted alloc changes (e.g. after an apply echo refreshes
  // the roster). The local draft is editable; Apply commits it.
  const serverAlloc = useMemo(() => ship.statAlloc, [ship.statAlloc]);
  const [draft, setDraft] = useState(() => toDraft(serverAlloc));

  // Re-seed the draft from the server allocation when the modal (re)opens or the
  // persisted allocation changes — so a respec / external apply is reflected.
  useEffect(() => {
    if (open) setDraft(toDraft(serverAlloc));
  }, [open, serverAlloc]);

  const remaining = remainingPoints(draft, level);
  const budget = level - 1 > 0 ? level - 1 : 0;
  // Enable Apply only when the draft differs from the server's current alloc.
  // Compare the canonical (zero-stripped) shapes so re-adding then removing a
  // point reads as "no change".
  const dirty =
    JSON.stringify(draftToAlloc(draft)) !== JSON.stringify(draftToAlloc(toDraft(serverAlloc)));

  const handleApply = (): void => {
    onApply(ship.shipId, draftToAlloc(draft));
  };

  const handleRespec = (): void => {
    setDraft(toDraft({}));
    onRespec(ship.shipId);
  };

  // Phase 4 WS-B3 — latent weapon mounts. Candidate hardpoints come from the
  // catalogue; `ship.mounts` (activated) tells which are already on. The player
  // picks a weapon then activates ONE latent slot.
  const latentMounts = kind.latentMounts ?? [];
  const activatedSlotIds = useMemo(
    () => new Set((ship.mounts ?? []).map((m) => m.slotId)),
    [ship.mounts],
  );
  const [mountWeapon, setMountWeapon] = useState<'hitscan' | 'laser' | 'heat-seeker'>('laser');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      keepMounted
      maxWidth="xs"
      fullWidth
      data-testid="upgrade-modal"
      PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a2f40' } }}
    >
      <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88', display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <span>{kind.displayName}</span>
        <LevelBadge level={level} />
      </DialogTitle>
      <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
        <Typography
          variant="caption"
          data-testid="upgrade-points-remaining"
          data-remaining={remaining}
          data-budget={budget}
          sx={{ color: remaining > 0 ? '#00ff88' : '#888', display: 'block', textAlign: 'center', mb: 1.5 }}
        >
          {remaining} / {budget} points to spend
        </Typography>
        <Stack spacing={0.75}>
          {STAT_IDS.map((id) => {
            const points = draft[id] ?? 0;
            return (
              <Box
                key={id}
                data-testid={`upgrade-row-${id}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto auto',
                  alignItems: 'center',
                  columnGap: 0.5,
                }}
              >
                <Typography variant="body2" sx={{ color: '#bfc4d6', fontSize: 12 }}>
                  {STAT_LABELS[id]}
                </Typography>
                <IconButton
                  size="small"
                  data-testid={`upgrade-dec-${id}`}
                  disabled={points <= 0}
                  onClick={() => setDraft((d) => adjustDraft(d, id, -1, level))}
                  sx={{ color: '#9aa0b4', p: 0.25 }}
                >
                  <RemoveIcon fontSize="inherit" />
                </IconButton>
                <Typography
                  variant="body2"
                  data-testid={`upgrade-value-${id}`}
                  data-points={points}
                  sx={{ minWidth: 24, textAlign: 'center', color: points > 0 ? '#00ff88' : '#778', fontSize: 12 }}
                >
                  +{points}
                </Typography>
                <IconButton
                  size="small"
                  data-testid={`upgrade-inc-${id}`}
                  disabled={remaining <= 0}
                  onClick={() => setDraft((d) => adjustDraft(d, id, +1, level))}
                  sx={{ color: '#00ff88', p: 0.25 }}
                >
                  <AddIcon fontSize="inherit" />
                </IconButton>
              </Box>
            );
          })}
        </Stack>

        {/* Phase 4 WS-B3 — dynamic weapon mounts (latent slots). */}
        {onActivateMount !== undefined && latentMounts.length > 0 && (
          <Box data-testid="upgrade-mounts" sx={{ mt: 1.5, pt: 1, borderTop: '1px solid #2a2f40' }}>
            <Typography variant="caption" sx={{ color: '#8aa0ff', display: 'block', mb: 0.5 }}>
              Weapon mounts
            </Typography>
            {/* Weapon picker for the next activation. */}
            <Box sx={{ display: 'flex', gap: 0.5, mb: 0.75 }}>
              {MOUNT_WEAPON_CHOICES.map((w) => (
                <Button
                  key={w.id}
                  size="small"
                  data-testid={`mount-weapon-${w.id}`}
                  data-selected={mountWeapon === w.id ? '1' : '0'}
                  onClick={() => setMountWeapon(w.id)}
                  sx={{
                    flex: 1,
                    fontSize: 11,
                    color: mountWeapon === w.id ? '#00ff88' : '#9aa0b4',
                    border: mountWeapon === w.id ? '1px solid #1f7a4d' : '1px solid #2a2f40',
                    p: 0.25,
                  }}
                >
                  {w.label}
                </Button>
              ))}
            </Box>
            <Stack spacing={0.5}>
              {latentMounts.map((lm) => {
                const active = activatedSlotIds.has(lm.id);
                return (
                  <Box
                    key={lm.id}
                    data-testid={`mount-slot-${lm.id}`}
                    data-active={active ? '1' : '0'}
                    sx={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', columnGap: 0.5 }}
                  >
                    <Typography variant="body2" sx={{ color: active ? '#00ff88' : '#bfc4d6', fontSize: 12 }}>
                      {lm.id}
                    </Typography>
                    {active ? (
                      <Typography variant="caption" sx={{ color: '#00ff88', fontSize: 11 }}>
                        Active
                      </Typography>
                    ) : (
                      <Button
                        size="small"
                        data-testid={`mount-activate-${lm.id}`}
                        onClick={() => onActivateMount(ship.shipId, lm.id, mountWeapon)}
                        sx={{ fontSize: 11, color: '#00ff88', border: '1px solid #1f7a4d', p: 0.25 }}
                      >
                        Activate
                      </Button>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0c1020', justifyContent: 'space-between', px: 2.5, pb: 2 }}>
        <Button
          onClick={handleRespec}
          startIcon={<RestartAltIcon />}
          data-testid="upgrade-respec"
          sx={{ color: '#ffb347', border: '1px solid #5a4520', '&:hover': { bgcolor: 'rgba(255,179,71,0.08)' } }}
        >
          Respec
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} sx={{ color: '#9aa0b4' }} data-testid="upgrade-close">Close</Button>
          <Button
            onClick={handleApply}
            variant="contained"
            data-testid="upgrade-apply"
            disabled={!dirty}
            sx={{ bgcolor: '#1f7a4d', color: '#fff', '&:hover': { bgcolor: '#288c5b' } }}
          >
            Apply
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}
