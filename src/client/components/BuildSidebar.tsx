/**
 * The Build menu: a right-hand side panel (SidePanel.tsx) opened from the speed
 * dial's Build action and by entering Build mode. A vertical rail of the build
 * categories (buildCategories.tsx) runs down its LEFT edge; the active category
 * shows a grid of kind tiles (BuildKindTile.tsx). A tile tap is the dial's old
 * kind pick (`onPick` → `setPlacementKind`); SpeedDialMenu owns the open flag.
 *
 * One right panel at a time: opening this clears `structureSettingsOpen`, which
 * closes the building settings panel; that panel opening announces a game
 * window, which closes this (SpeedDialMenu's onGameWindowOpen).
 *
 * Its own ✕ (it covers the top-right dial), Esc (SidePanel) and a swipe on the
 * handle close it. The active category is local state (presentation only), kept
 * across closes so the next structure is one tap away.
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import type { StructureKindId } from '@shared-types/structureKinds';
import { buildEntry } from '@shared-types/packedStock';
import { HUD } from '../hud/tokens';
import { useUIStore } from '../state/store';
import { usePackedStock } from '../structures/usePackedStock';
import { BUILD_CATEGORIES, CATEGORY_ICON, categoryById, type BuildCategoryId } from './buildCategories';
import { BuildKindTile } from './BuildKindTile';
import { BUILD_PANEL_SIZE, SidePanel } from './SidePanel';
import { WINDOW_HEAD_SX, WINDOW_ROOT_SX, WINDOW_TITLE_SX, WINDOW_X_SX } from './GameWindow';

export interface BuildSidebarProps {
  open: boolean;
  onClose: () => void;
  onPick: (kind: StructureKindId) => void;
}

export function BuildSidebar({ open, onClose, onPick }: BuildSidebarProps): JSX.Element {
  const [category, setCategory] = useState<BuildCategoryId>(BUILD_CATEGORIES[0]!.id);
  // Stock keeps polling while placing: the keep-placing rule reads it (placementCancel.ts).
  const placing = useUIStore((s) => s.placementKind !== null);
  const packedStock = usePackedStock(open || placing);
  const inSector = useUIStore((s) => s.currentSectorKey !== null); // no sector = no crate rule
  useEffect(() => {
    if (open && useUIStore.getState().structureSettingsOpen) useUIStore.setState({ structureSettingsOpen: false });
  }, [open]);
  const cat = categoryById(category);
  return (
    <SidePanel open={open} onClose={onClose} testId="build-sidebar" size={BUILD_PANEL_SIZE} closeOnEscape
      paperAttrs={{ 'data-open': open ? '1' : '0' }}>
      {open && (
        <Box sx={WINDOW_ROOT_SX}>
          <Box sx={WINDOW_HEAD_SX}>
            <Box sx={WINDOW_TITLE_SX}>Build</Box>
            <Box component="button" sx={WINDOW_X_SX} onClick={onClose} aria-label="Close" data-testid="build-sidebar-close">✕</Box>
          </Box>
          <Box sx={BODY_SX}>
            <Box sx={RAIL_SX} role="tablist" aria-orientation="vertical" data-testid="build-rail">
              {BUILD_CATEGORIES.map((c) => (
                <Box key={c.id} component="button" type="button" role="tab" aria-selected={c.id === category}
                  aria-label={c.label} title={c.label} data-testid={`build-cat-${c.id}`}
                  sx={c.id === category ? RAIL_BTN_ACTIVE_SX : RAIL_BTN_SX} onClick={() => setCategory(c.id)}>
                  {CATEGORY_ICON[c.id]}
                </Box>
              ))}
            </Box>
            <Box sx={KINDS_SX} data-testid="build-kinds" data-category={category}>
              <Box sx={CAT_LABEL_SX}>{cat.label}</Box>
              <Box sx={GRID_SX}>
                {cat.kinds.map((k) => (
                  <BuildKindTile key={k} kindId={k} entry={buildEntry(k, packedStock, inSector)} onPick={onPick} />
                ))}
              </Box>
            </Box>
          </Box>
        </Box>
      )}
    </SidePanel>
  );
}

const C = HUD.color;
const RAIL_ICON_PX = 40;
const BODY_SX = { flex: '1 1 auto', minHeight: 0, display: 'flex' } as const;
// The rail scrolls when the categories do not fit the panel's height.
const RAIL_SX = {
  flex: 'none', display: 'flex', flexDirection: 'column', gap: '4px', p: '6px 4px',
  overflowY: 'auto', overscrollBehavior: 'contain', borderRight: `1px solid ${C.panelEdge}`,
} as const;
const RAIL_BTN_SX = {
  flex: 'none', width: RAIL_ICON_PX, height: RAIL_ICON_PX, display: 'flex', alignItems: 'center', justifyContent: 'center',
  p: 0, cursor: 'pointer', color: C.inkDim, bgcolor: 'transparent', border: '1px solid transparent', borderRadius: '4px',
  '&:hover': { color: C.ink, bgcolor: 'rgba(255,255,255,0.06)' },
} as const;
const RAIL_BTN_ACTIVE_SX = { ...RAIL_BTN_SX, color: C.auto, borderColor: C.autoGlow, bgcolor: 'rgba(52,216,255,0.12)' } as const;
const KINDS_SX = { flex: '1 1 auto', minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain', p: 1 } as const;
const CAT_LABEL_SX = {
  color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', mb: 0.75,
  fontFamily: HUD.font.label,
} as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '6px' } as const;
