/**
 * Cargo pods: the loot window. The game's window frame (GameWindow.tsx: a
 * fixed, opaque, screen-space Dialog) that holds the cargo panel for a
 * pod, a storage structure or a ship. It replaces the panel that used to grow
 * inside the world-anchored inspector: the window keeps its size and place
 * while stacks reveal or move, so taps always land. Opened from the left
 * strip's cargo / pod icon (`layout/selectionStripItems.tsx`).
 */
import { GameWindow } from './GameWindow';
import { CargoPanel, type CargoPanelProps } from './CargoPanel';

export interface LootWindowProps extends CargoPanelProps {
  open: boolean;
  /** What is being looted ("Cargo pod", a structure's or ship's name). */
  title: string;
  /** A chip beside the name, e.g. the pod's size. */
  subtitle?: string;
  /** The left grid's heading ("Pod contents"). */
  theirsLabel?: string;
  onClose: () => void;
}

export function LootWindow({ open, title, subtitle, theirsLabel, onClose, entityId, ship }: LootWindowProps): JSX.Element {
  return (
    <GameWindow open={open} onClose={onClose} testId="loot-window">
      {open && (
        <CargoPanel
          {...(ship !== undefined ? { ship } : { entityId })} title={title} onClose={onClose}
          {...(subtitle !== undefined ? { subtitle } : {})} {...(theirsLabel !== undefined ? { theirsLabel } : {})}
        />
      )}
    </GameWindow>
  );
}
