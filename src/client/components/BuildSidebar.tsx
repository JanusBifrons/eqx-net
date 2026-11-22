/**
 * The Build menu: a right-hand side panel (SidePanel.tsx). Build mode is the
 * only way in (owner, 2026-11-22: one way to build): entering Build opens it, and
 * tapping Build again while in Build brings it back after a ✕
 * ({@link requestBuildSidebar}). The speed dial no longer builds. A vertical rail of the build
 * categories (buildCategories.tsx) runs down its LEFT edge; the active category
 * shows a grid of kind tiles (BuildKindTile.tsx, drawn by the shared HullTile).
 * A tile tap is the dial's old kind pick (`onPick` → `setPlacementKind`);
 * SpeedDialMenu owns the open flag. Under the grid, a details strip shows the
 * hovered (desktop) or last tapped kind: a locked tile's tap shows why.
 *
 * One right panel at a time: opening this clears `structureSettingsOpen`, which
 * closes the building settings panel; that panel opening announces a game
 * window, which closes this (SpeedDialMenu's onGameWindowOpen).
 *
 * Its ✕ (SidePanel draws the header; it covers the top-right dial; on a phone the
 * header shares the top-right toolbar's row), Esc (SidePanel) and a swipe on the
 * handle close it. The active category is local state (presentation only), kept
 * across closes so the next structure is one tap away.
 *
 * Desktop keys while open (input/buildMenuKeys.ts; they moved here from the old
 * bottom build hotbar): 1–9 pick the Nth tile of the open category (a tile click),
 * Q / E step to the previous / next category. The fire-control keys stand down
 * meanwhile, so 1–9 do not also switch weapon groups.
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import type { StructureKindId } from '@shared-types/structureKinds';
import { buildEntry } from '@shared-types/packedStock';
import { HUD } from '../hud/tokens';
import { useUIStore } from '../state/store';
import { usePackedStock } from '../structures/usePackedStock';
import { BUILD_CATEGORIES, CATEGORY_ICON, categoryById, type BuildCategoryId } from './buildCategories';
import { BuildKindDetails, BuildKindTile } from './BuildKindTile';
import { BUILD_PANEL_SIZE, SidePanel } from './SidePanel';
import { WINDOW_ROOT_SX } from './GameWindow';
import { buildMenuKeyAction, setBuildMenuKeysOpen, stepCategory } from '../input/buildMenuKeys';

const reopenListeners = new Set<() => void>();
/** Run `fn` when the Build mode switch asks for the sidebar again (a Build tap
 *  while already in Build); returns the unsubscribe. SpeedDialMenu owns the
 *  open flag and listens. */
export function onBuildSidebarRequest(fn: () => void): () => void {
  reopenListeners.add(fn);
  return () => { reopenListeners.delete(fn); };
}
/** Ask for the Build sidebar (PilotSpectatorToggle's Build tap while in Build). */
export function requestBuildSidebar(): void {
  for (const fn of reopenListeners) fn();
}

const CATEGORY_IDS: readonly BuildCategoryId[] = BUILD_CATEGORIES.map((c) => c.id);

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.tagName && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

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
  const [shown, setShown] = useState<StructureKindId | null>(null);
  const cat = categoryById(category);
  const shownKind = shown !== null && cat.kinds.includes(shown) ? shown : null;
  // 1–9 / Q / E while open (see the header): the old hotbar's number-key path.
  useEffect(() => {
    if (!open) return;
    setBuildMenuKeysOpen(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      const a = buildMenuKeyAction(e.key, e.code);
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'step') {
        setCategory(stepCategory(CATEGORY_IDS, category, a.delta));
        return;
      }
      const k = cat.kinds[a.index];
      if (k === undefined) return;
      setShown(k);
      if (!buildEntry(k, packedStock, inSector).locked) onPick(k);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setBuildMenuKeysOpen(false);
    };
  }, [open, category, cat, packedStock, inSector, onPick]);
  return (
    <SidePanel open={open} onClose={onClose} testId="build-sidebar" size={BUILD_PANEL_SIZE} closeOnEscape
      paperAttrs={{ 'data-open': open ? '1' : '0' }} title="Build" headerTestId="build-sidebar-head" closeTestId="build-sidebar-close">
      {open && (
        <Box sx={WINDOW_ROOT_SX}>
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
            <Box sx={KINDS_COL_SX}>
              <Box sx={KINDS_SX} data-testid="build-kinds" data-category={category}>
                <Box sx={CAT_LABEL_SX}>{cat.label}</Box>
                <Box sx={GRID_SX}>
                  {cat.kinds.map((k) => (
                    <BuildKindTile key={k} kindId={k} entry={buildEntry(k, packedStock, inSector)} onPick={onPick}
                      onShow={setShown} selected={k === shownKind} />
                  ))}
                </Box>
              </Box>
              <BuildKindDetails kindId={shownKind} entry={shownKind === null ? null : buildEntry(shownKind, packedStock, inSector)} />
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
const KINDS_COL_SX = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } as const;
const KINDS_SX = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', p: 1 } as const;
const CAT_LABEL_SX = {
  color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', mb: 0.75,
  fontFamily: HUD.font.label,
} as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '6px' } as const;
