import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { SHIP_KINDS_LIST, type ShipKind, type ShipKindId } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';

interface ShipPickerModalProps {
  open: boolean;
  onClose: () => void;
  selectedKind: ShipKindId;
  onSelect: (id: ShipKindId) => void;
}

/**
 * Modal that lets the player pick which ship kind to spawn with on the next
 * sector entry. The trigger button (in `GalaxyMapScreen`) is responsible for
 * being disabled while a ship is currently spawned — by the time this modal
 * opens, selection is always safe.
 *
 * Per-card stat chips (max speed, turn agility, hull) are derived from the
 * catalogue values directly — adding a 4th kind in `shipKinds.ts` makes it
 * appear here automatically with no edit to this file.
 */
export function ShipPickerModal({ open, onClose, selectedKind, onSelect }: ShipPickerModalProps): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      data-testid="ship-picker-modal"
      PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a2f40' } }}
    >
      <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88' }}>Select your ship</DialogTitle>
      <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
        <Stack spacing={1.5}>
          {SHIP_KINDS_LIST.map((kind) => (
            <ShipCard
              key={kind.id}
              kind={kind}
              isSelected={kind.id === selectedKind}
              onSelect={() => {
                onSelect(kind.id);
                onClose();
              }}
            />
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0c1020' }}>
        <Button onClick={onClose} sx={{ color: '#9aa0b4' }} data-testid="ship-picker-close">Close</Button>
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
    <Box
      onClick={onSelect}
      data-testid={`ship-card-${kind.id}`}
      sx={{
        display: 'flex',
        gap: 2,
        p: 1.5,
        border: '1px solid',
        borderColor: isSelected ? '#1f7a4d' : '#2a2f40',
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: isSelected ? 'rgba(0,255,136,0.04)' : 'transparent',
        '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.04)' },
        alignItems: 'center',
      }}
    >
      <Box sx={{ flexShrink: 0, width: 80, display: 'flex', justifyContent: 'center' }}>
        <ShipSilhouette shape={kind.shape} size={64} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="baseline" spacing={1}>
          <Typography variant="subtitle1" sx={{ color: '#00ff88' }}>{kind.displayName}</Typography>
          {isSelected && (
            <Typography variant="caption" sx={{ color: '#9aa0b4' }} data-testid={`ship-card-${kind.id}-selected`}>
              · selected
            </Typography>
          )}
        </Stack>
        <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 0.75 }}>
          {kind.description}
        </Typography>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          <StatChip label="Top" value={Math.round(kind.maxSpeed)} />
          <StatChip label="Turn" value={kind.maxAngvel.toFixed(1)} />
          <StatChip label="Hull" value={Math.round(kind.maxHealth)} />
        </Stack>
      </Box>
    </Box>
  );
}

function StatChip({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <Chip
      size="small"
      label={`${label} ${value}`}
      sx={{
        bgcolor: 'rgba(0,255,136,0.06)',
        color: '#cde',
        height: 22,
        '& .MuiChip-label': { px: 1, fontSize: 11 },
      }}
    />
  );
}
