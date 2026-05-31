import { Box, Button, Card, CardActionArea, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { useEffect, useState } from 'react';
import { SHIP_KINDS_LIST, type ShipKind, type ShipKindId } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';

interface ShipPickerModalProps {
  open: boolean;
  onClose: () => void;
  selectedKind: ShipKindId;
  onSelect: (id: ShipKindId) => void;
  /** Optional title override. When unset, displays "Select your ship".
   *  The Phase 3 galaxy-map sector-click flow passes "Spawn in
   *  {sectorName}" so the modal reads as the spawn confirmation step. */
  title?: string;
  /** Optional one-line subtitle under the title. Phase 3 uses this for
   *  "Pick a ship kind for this sector" or a roster-cap warning. */
  subtitle?: string;
}

/**
 * Compact MUI ship-kind picker. Two-step flow:
 *  1. Click a card → tentative selection (highlighted).
 *  2. Click "Spawn" → fires `onSelect(kind)` and closes.
 *
 * `selectedKind` (last-chosen kind from Zustand) pre-fills the tentative
 * selection so the player can hit Spawn immediately. Cards use MUI Card +
 * CardActionArea so the press feedback feels native; sizing is deliberately
 * tight — silhouette + name + slim stats line, no full description.
 */
export function ShipPickerModal({ open, onClose, selectedKind, onSelect, title, subtitle }: ShipPickerModalProps): JSX.Element {
  const [tentative, setTentative] = useState<ShipKindId>(selectedKind);
  // Reset the tentative selection to the prop whenever the modal opens.
  // Without this, a player who picked X last time and now wants Y starts
  // with X pre-selected — fine; but if the prop changes mid-life (e.g.
  // Zustand updates from another path), the tentative state should follow.
  useEffect(() => { if (open) setTentative(selectedKind); }, [open, selectedKind]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      data-testid="ship-picker-modal"
      PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a2f40', m: 1 } }}
      // Plan: crispy-kazoo, Commit 7 — drop the MUI Grow transition
      // (~225 ms default) for sector-pick responsiveness. Combined
      // with the existing `PICKER_OPEN_DELAY_MS = 200` touch-bleed
      // guard (load-bearing, do NOT touch), the modal goes from
      // ~430 ms to ~230 ms click-to-visible. The transition was
      // unjustified polish; the modal contents are still informative
      // without the eased-in feel.
      transitionDuration={{ enter: 0, exit: 0 }}
    >
      <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88', fontSize: 14, py: 1, px: 1.5 }}>
        {title ?? 'Select your ship'}
        {subtitle !== undefined && (
          <Typography sx={{ display: 'block', color: '#888', mt: 0.25, fontWeight: 400, fontSize: 10 }}>
            {subtitle}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc', px: 1, py: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 0.75 }}>
          {SHIP_KINDS_LIST.map((kind) => (
            <ShipCard
              key={kind.id}
              kind={kind}
              isSelected={kind.id === tentative}
              onSelect={() => setTentative(kind.id)}
            />
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0c1020', px: 1.5, py: 1 }}>
        <Button onClick={onClose} size="small" sx={{ color: '#9aa0b4', fontSize: 11 }} data-testid="ship-picker-close">
          Cancel
        </Button>
        <Button
          onClick={() => { onSelect(tentative); onClose(); }}
          size="small"
          variant="contained"
          startIcon={<RocketLaunchIcon sx={{ fontSize: 14 }} />}
          data-testid="ship-picker-spawn"
          sx={{ bgcolor: '#1f7a4d', color: '#fff', fontSize: 11, '&:hover': { bgcolor: '#288c5b' } }}
        >
          Spawn
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface ShipCardProps {
  kind: ShipKind;
  isSelected: boolean;
  onSelect: () => void;
}

function ShipCard({ kind, isSelected, onSelect }: ShipCardProps): JSX.Element {
  return (
    <Card
      elevation={0}
      data-testid={`ship-card-${kind.id}`}
      data-selected={isSelected ? '1' : '0'}
      sx={{
        bgcolor: 'transparent',
        border: '1px solid',
        borderColor: isSelected ? '#1f7a4d' : '#2a2f40',
        borderRadius: 1,
      }}
    >
      <CardActionArea
        onClick={onSelect}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          p: 0.75,
          bgcolor: isSelected ? 'rgba(0,255,136,0.06)' : 'transparent',
          '&:hover': { bgcolor: 'rgba(0,255,136,0.04)' },
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 0.25 }}>
          <ShipSilhouette shape={kind.shape} size={36} />
        </Box>
        <Typography sx={{ color: isSelected ? '#00ff88' : '#cde', fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: 1.1 }}>
          {kind.displayName}
        </Typography>
        <Typography sx={{ color: '#888', fontSize: 9, textAlign: 'center', lineHeight: 1.1, mt: 0.25 }}>
          {Math.round(kind.maxSpeed)} spd · {Math.round(kind.maxHealth)} hull
        </Typography>
      </CardActionArea>
    </Card>
  );
}
