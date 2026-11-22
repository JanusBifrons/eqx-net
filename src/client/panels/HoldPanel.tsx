/**
 * Rail item Hold (UI plan U1-5 stub): opens today's surface, your hold's loot
 * window (the same LootWindow the CargoChip tap opens), while the `rightPanel`
 * flag is `hold`. Its ✕ and Esc clear the flag. U2-4 moves the own-hold part of
 * CargoPanel in here as a real panel and retires CargoChip's local `open`.
 */
import { useUIStore } from '../state/store';
import { LootWindow } from '../components/LootWindow';

export function HoldPanel(): JSX.Element | null {
  const open = useUIStore((s) => s.rightPanel === 'hold');
  const playerId = useUIStore((s) => s.playerId);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  if (playerId === null) return null;
  return <LootWindow open={open} title="Your ship · Hold" ship={playerId} onClose={() => setRightPanel(null)} />;
}
